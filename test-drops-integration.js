/**
 * test-drops-integration.js — src/drops.js, wired end to end.
 *
 * test-drops.js proves the MODULE is pure and correct. This file proves the SERVER
 * actually uses it: a real player, killed by a real monster on a real server, spills
 * half their raw resources at the tile they died on; a nearby client is told about the
 * cache through the ordinary chunk/view machinery; the cache survives a server restart;
 * and another player who walks up to it picks it up over the wire (inventory grows,
 * the cache disappears for everyone watching that chunk).
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-integration.js
 * and test-restart.js. Spawns its own server(s) on an ephemeral port with its own DB
 * (data/test-drops-integration.db) — never 8090, never the live DB.
 *
 *   node test-drops-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-drops-integration.db');
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
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; this.drops = new Map(); }
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
        socket.on('error', () => {});   // the server dies mid-suite (restart phase) — expected, not a test failure
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
      if (m.t === 'chunk' && m.drops) for (const d of m.drops) this.drops.set(d.x + ',' + d.y, d);
      if (m.t === 'drop') this.drops.set(m.x + ',' + m.y, m);
      if (m.t === 'drop-gone') this.drops.delete(m.x + ',' + m.y);
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
  monsters() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'mons') return this.msgs[i].list;
    return [];
  }
  monById(id) { for (const e of this.monsters()) if (e[0] === id) return e; return null; }
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
  console.log('\nSTRATUM death drops integration — live server, real wire\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const a = new Client('A', port);
  await a.connect();

  section('SETUP — a fresh hunter, and a real monster willing to kill them');
  a.send({ t: 'hello', key: 'drops-key-AAAA-0001', name: 'CORPSE' });
  const w = await a.waitFor(m => m.t === 'welcome');
  ok(w.inv && w.inv.wood === 6 && w.inv.ore === 4 && w.inv.herb === 2 && w.inv.crystal === 1,
    'the doomed hunter starts with the usual starter cache {6,4,2,1}', w.inv);
  const map = w.map;
  const p0 = w.spawn;

  // Half-floor split predicted by src/drops.js for the starter cache: 6/4/2/1.
  const wantDrop = { wood: 3, ore: 2, herb: 1 };            // crystal:1 -> floor(1/2)=0, never dropped
  const wantKept = { wood: 3, ore: 2, herb: 1, crystal: 1 };

  // Pick the nearest monster home that actually closes to melee (never a kiter/spitter,
  // which would keep its distance forever and never land a blow).
  const homes = T.homesNear(map, Math.round(p0.x), Math.round(p0.y), 4)
    .map(h => Object.assign({ d: Math.hypot(h.x - p0.x, h.y - p0.y) }, h))
    .filter(h => h.sp.role === 'tank' || h.sp.role === 'brute' || h.sp.role === 'pack' || h.sp.role === 'swarm')
    .sort((x, y) => x.d - y.d);
  const home = homes[0] || null;
  ok(!!home, home ? `chose a resident ${home.sp.kind} home at ${Math.round(home.x)},${Math.round(home.y)} (${Math.round(home.d)} tiles away)` : 'no melee-capable home found near spawn');
  if (!home) { srv.kill('SIGTERM'); process.exit(1); }

  section('DEATH — stand and take it; the hunter must fall, and the cache must land');
  await a.approach(home.x, home.y, Math.max(2.4, home.sp.aggro - 1), 40000);
  await sleep(400);
  const stand = a.pos() || { x: Math.round(home.x), y: Math.round(home.y) };
  const dx0 = Math.round(stand.x), dy0 = Math.round(stand.y);

  // Hold position (no more 'move') and just answer keepalive pings while the world kills us.
  let died = null;
  const keepalive = setInterval(() => a.send({ t: 'ping', c: Date.now() }), 4000);
  try {
    died = await a.waitNew(m => m.t === 'died', 90000);
  } catch (e) { /* handled by the ok() below */ }
  clearInterval(keepalive);
  ok(!!died, 'the hunter was slain by ' + (died && died.by), died && died.by);
  if (!died) { srv.kill('SIGTERM'); process.exit(1); }

  ok(died.inv && died.inv.wood === wantKept.wood && died.inv.ore === wantKept.ore &&
    died.inv.herb === wantKept.herb && died.inv.crystal === wantKept.crystal,
    'the death message carries the halved inventory ' + JSON.stringify(wantKept), died.inv);

  section('VISIBILITY — a bystander sees the cache through ordinary chunk/view delivery');
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'drops-key-BBBB-0002', name: 'SCAVENGER' });
  await b.waitFor(m => m.t === 'welcome');
  b.send({ t: 'view', x: dx0, y: dy0 });
  await b.waitFor(m => m.t === 'chunk' && m.map === map, 6000).catch(() => {});
  await sleep(300);
  const seen = b.drops.get(dx0 + ',' + dy0);
  ok(!!seen, 'the bystander received the cache at ' + dx0 + ',' + dy0 + ' via chunk/view delivery', seen);
  ok(seen && seen.res && seen.res.wood === wantDrop.wood && seen.res.ore === wantDrop.ore && seen.res.herb === wantDrop.herb,
    'the cache holds exactly the halved resources ' + JSON.stringify(wantDrop), seen && seen.res);
  b.close();

  section('RESTART — the cache must survive a server restart, not be silently lost or duplicated');
  a.close();
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  port = await freePort();
  srv = startServer(port);
  await waitReady(port);

  const c = new Client('C', port);
  await c.connect();
  c.send({ t: 'hello', key: 'drops-key-CCCC-0003', name: 'LATECOMER' });
  await c.waitFor(m => m.t === 'welcome');
  c.send({ t: 'view', x: dx0, y: dy0 });
  await c.waitFor(m => m.t === 'chunk' && m.map === map, 6000).catch(() => {});
  await sleep(300);
  const afterRestart = c.drops.get(dx0 + ',' + dy0);
  ok(!!afterRestart, 'the cache is still there after a restart (loaded from disk, not lost)', afterRestart);
  ok(afterRestart && afterRestart.res && afterRestart.res.wood === wantDrop.wood && afterRestart.res.ore === wantDrop.ore && afterRestart.res.herb === wantDrop.herb,
    'and it still holds exactly the same resources — not duplicated, not corrupted', afterRestart && afterRestart.res);

  section('PICKUP — a player walks over it and it is gone, for everyone watching');
  const d = new Client('D', port);
  await d.connect();
  d.send({ t: 'hello', key: 'drops-key-DDDD-0004', name: 'LOOTER' });
  const wd = await d.waitFor(m => m.t === 'welcome');
  const invBefore = Object.assign({}, wd.inv);
  d.send({ t: 'view', x: dx0, y: dy0 });
  await d.waitFor(m => m.t === 'chunk' && m.map === map, 6000).catch(() => {});
  await d.approach(dx0, dy0, 5, 25000);
  d.send({ t: 'pickup', x: dx0, y: dy0 });
  const picked = await d.waitNew(m => m.t === 'pickup', 5000).catch(() => null);
  ok(!!picked && !picked.err, 'pickup succeeded over the wire', picked);
  ok(picked && picked.taken && picked.taken.wood === wantDrop.wood && picked.taken.ore === wantDrop.ore && picked.taken.herb === wantDrop.herb,
    'exactly the cache contents were taken ' + JSON.stringify(wantDrop), picked && picked.taken);
  ok(picked && picked.inv && picked.inv.wood === invBefore.wood + wantDrop.wood &&
    picked.inv.ore === invBefore.ore + wantDrop.ore && picked.inv.herb === invBefore.herb + wantDrop.herb,
    'the looter\'s inventory grew by exactly the cache', { before: invBefore, after: picked && picked.inv });

  // 'drop-gone' is broadcast BEFORE the direct 'pickup' reply, so by now it is already
  // sitting in the message history — waitFor (not waitNew) is what finds it.
  const gone = await d.waitFor(m => m.t === 'drop-gone' && m.x === dx0 && m.y === dy0, 2000).catch(() => null);
  ok(!!gone, 'the cache is broadcast as gone (drop-gone) to everyone watching that chunk', gone);
  ok(!d.drops.has(dx0 + ',' + dy0), 'the looter\'s own client-side view no longer shows the cache');

  // a second pickup attempt on the same empty tile must fail cleanly, never double-grant
  d.send({ t: 'pickup', x: dx0, y: dy0 });
  const again = await d.waitNew(m => m.t === 'pickup', 5000).catch(() => null);
  ok(!!again && !!again.err, 'picking up an already-emptied tile is refused, not double-granted', again);
  d.close();

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
