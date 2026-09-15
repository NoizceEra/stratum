'use strict';
/**
 * test-integration.js — the economy, wired end to end.
 *
 * test-economy.js proves the MODULE is pure and correct. This file proves the
 * SERVER actually uses it: placing tiles spends resources, crafting and tool
 * upgrades work over the wire, harvest never pays less than bare hands, and the
 * tool tier survives a reconnect. Spawns its own server on an ephemeral port
 * with its own DB (data/test-integration.db) — never 8090, never the live DB.
 *
 *   node test-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-integration.db');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LIVE_PORT = 8090;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }

function wipe(db) { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + s); } catch (e) {} } }
function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function startServer(port) {
  if (port === LIVE_PORT) throw new Error('refusing to run a test server on ' + LIVE_PORT);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.log = '';
  srv.exited = null;
  const cap = (d) => { srv.log += d.toString(); if (srv.log.length > 200000) srv.log = srv.log.slice(-100000); };
  srv.stdout.on('data', cap);
  srv.stderr.on('data', cap);
  srv.on('exit', (code, sig) => { srv.exited = code === null ? 'signal:' + sig : code; });
  return srv;
}
function waitReady(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stats' }, res => { res.resume(); resolve(); });
      req.on('error', () => { if (++tries > 100) return reject(new Error('server never came up on :' + port)); setTimeout(tick, 150); });
    };
    tick();
  });
}

class Client {
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; this.nodes = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', (d) => this._feed(d));
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const txt = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      let m; try { m = JSON.parse(txt); } catch (e) { continue; }
      if (m.t === 'chunk' && m.nodes) for (const n of m.nodes) this.nodes.push({ map: m.map, x: n[0], y: n[1], kind: n[2], state: n[3] });
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => { if (w.test(m)) { w.resolve(m); return false; } return true; });
    }
  }
  send(o) {
    const p = Buffer.from(JSON.stringify(o));
    const mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    const body = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
    this.socket.write(Buffer.concat([head, mask, body]));
  }
  waitFor(test, ms) {
    const hit = this.msgs.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout')); }, ms || 5000);
    });
  }
  waitNew(test, ms) {
    const from = this.msgs.length;
    const scan = () => {
      for (let i = from; i < this.msgs.length; i++) if (test(this.msgs[i])) return this.msgs[i];
      return null;
    };
    const hit = scan();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test: () => { const r = scan(); if (r) { w.resolve(r); return true; } return false; }, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout(new)')); }, ms || 5000);
    });
  }
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'players' && m.you) return { x: m.you[0], y: m.you[1] };
    }
    return null;
  }
  async approach(tx, ty, within, budgetMs) {
    const t0 = Date.now();
    let d = Infinity;
    while (Date.now() - t0 < (budgetMs || 25000)) {
      const p = this.pos();
      if (!p) { await sleep(150); continue; }
      const dx = tx - p.x, dy = ty - p.y;
      d = Math.hypot(dx, dy);
      if (d <= within) return d;
      const step = Math.min(1.5, d);
      this.send({ t: 'move', x: Math.round(p.x + (dx / d) * step), y: Math.round(p.y + (dy / d) * step) });
      await sleep(140);
    }
    return d;
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async function main() {
  console.log('\nSTRATUM economy integration — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const a = new Client('A', port);
  await a.connect();

  section('WELCOME — the catalogue ships with the handshake');
  a.send({ t: 'hello', key: 'integ-key-0001', name: 'MASON' });
  const w = await a.waitFor(m => m.t === 'welcome');
  ok(w.tool === 0, 'fresh arrival starts at flint tools (tool 0)', w.tool);
  ok(typeof w.level === 'number' && w.level >= 1, 'welcome carries the hunter level', w.level);
  ok(w.catalog && w.catalog.costs && w.catalog.costs.length === 10, 'catalogue prices all 10 materials', w.catalog && w.catalog.costs && w.catalog.costs.length);
  // 8 original weapon/armour recipes + 3 cozy decor recipes (ROADMAP_COZY §3) = 11
  ok(w.catalog && w.catalog.recipes && w.catalog.recipes.length === 11, 'catalogue lists all 11 recipes', w.catalog && w.catalog.recipes && w.catalog.recipes.length);
  ok(w.catalog && w.catalog.tools && w.catalog.tools.length === 4, 'catalogue lists all 4 tool tiers', w.catalog && w.catalog.tools && w.catalog.tools.length);
  ok(w.inv && w.inv.wood === 6 && w.inv.ore === 4 && w.inv.herb === 2 && w.inv.crystal === 1,
    'new arrivals wash up with the starter cache {6,4,2,1}', w.inv);
  const sp = w.spawn;

  section('CRAFT — refusal paths before a single resource is spent');
  a.send({ t: 'craft', id: 'r_steel_blade' });
  const poor = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_steel_blade');
  ok(poor.err && /insufficient|locked/i.test(poor.err), 'steel blade refused while poor (or tier-locked)', poor.err);
  a.send({ t: 'craft', id: 'r_iron_axe' });
  const locked = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_iron_axe');
  ok(locked.err && /locked/i.test(locked.err), 'iron axe is tier-locked behind better tools', locked.err);
  a.send({ t: 'craft', id: 'no_such_recipe' });
  const unk = await a.waitNew(m => m.t === 'crafted' && m.id === 'no_such_recipe');
  ok(unk.err && /unknown/i.test(unk.err), 'unknown recipe id fails cleanly', unk.err);

  section('TOOLUP — copper tools, paid over the wire');
  a.send({ t: 'toolup' });
  const tu = await a.waitNew(m => m.t === 'tooled');
  ok(!tu.err && tu.tool === 1 && tu.name === 'copper', 'toolup reaches copper (tool 1)', tu);
  ok(tu.inv && tu.inv.wood === 3 && tu.inv.ore === 2, 'toolup deducted exactly {wood 3, ore 2}', tu.inv);

  section('CRAFT — flint dagger, paid over the wire');
  a.send({ t: 'craft', id: 'r_flint_dagger' });
  const cf = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(!cf.err && cf.item === 'flint_dagger' && cf.count === 1, 'flint dagger crafted', cf);
  ok(cf.inv && cf.inv.wood === 1 && cf.inv.ore === 1 && cf.inv.flint_dagger === 1,
    'craft consumed exactly {wood 2, ore 1} and granted the blade', cf.inv);
  ok(cf.atkBoost === 3, 'the blade arms future swings (+3 attack)', cf.atkBoost);

  section('HARVEST — tools never pay less than bare hands');
  // the ground near spawn is ore seams (kind 2): walk to the nearest ripe one.
  // copper on ore computes exactly the base 2, so this asserts the max() floor holds.
  let seam = null;
  for (let i = 0; i < 40 && !seam; i++) {
    const p = a.pos();
    if (p) {
      let bd = 1e9;
      for (const n of a.nodes) {
        if (n.map !== 0 || n.state !== 1 || n.kind !== 2) continue;
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < bd) { bd = d; seam = n; }
      }
      if (!seam || bd > 60) seam = null;
    }
    if (!seam) await sleep(400);
  }
  ok(!!seam, 'the world showed us a ripe ore seam', seam && [seam.x, seam.y]);
  const d = await a.approach(seam.x, seam.y, 5, 30000);
  ok(d <= 5, 'walked into harvest reach of the seam', d);
  let gained = 0, swings = 0;
  while (gained === 0 && swings < 10) {
    a.send({ t: 'harvest', x: seam.x, y: seam.y });
    const h = await a.waitNew(m => m.t === 'harvested' && m.x === seam.x && m.y === seam.y, 4000);
    swings++;
    if (h.gains && h.gains.ore) gained = h.gains.ore;
    else if (h.err) break;
  }
  ok(gained === 2, 'a depleted seam pays the full 2 ore with copper tools (never nerfed)', { gained, swings });

  section('SET — placing land spends the sink, then refuses');
  const wx = sp.x + 3, wy = sp.y + 3;
  a.send({ t: 'set', x: wx, y: wy, m: 1 });
  const you = await a.waitNew(m => (m.t === 'you' || m.t === 'deny') && m.x === wx && m.y === wy, 4000);
  ok(you.t === 'you' && you.inv && you.inv.wood === 0, 'dirt placed and the last wood deducted (1 -> 0)', you.inv);
  // the player has walked to the seam by now: refuse adjacent to where they stand
  const pp = a.pos() || { x: seam.x, y: seam.y };
  const dx = Math.round(pp.x) + 1, dy = Math.round(pp.y);
  a.send({ t: 'set', x: dx, y: dy, m: 1 });
  const deny = await a.waitNew(m => m.t === 'deny' && m.x === dx, 4000);
  ok(deny.r === 'resources' && deny.missing && deny.missing.wood === 1,
    'broke builders are refused with the exact shortfall', deny);

  section('PERSISTENCE — the tool tier survives a reconnect');
  a.close();
  await sleep(300);
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'integ-key-0001', name: 'MASON' });
  const w2 = await b.waitFor(m => m.t === 'welcome');
  ok(w2.tool === 1, 'copper tools restored after reconnect', w2.tool);
  ok(w2.inv && w2.inv.flint_dagger === 1 && w2.inv.wood === 0 && w2.inv.ore === 3, 'crafted blade and spent purse restored', w2.inv);
  b.close();

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
