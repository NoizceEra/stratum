'use strict';
/**
 * test-crafting-grouping-integration.js — ROADMAP_COZY.md §3 (heavier crafting/gathering)
 * and §5 (light grouping), proven end to end.
 *
 * A REAL server, spawned by this file on an EPHEMERAL port (never 8090) with its own
 * throwaway DB under data/, driven by REAL WebSocket clients. No mocks.
 *
 * Proves:
 *   1. Harvesting a node to depletion grants XP, not just materials.
 *   2. Crafting a recipe grants XP.
 *   3. A second player standing NEAR a harvest gets a bystander XP credit without
 *      doing anything themselves — a single server-side event fanning credit out,
 *      never the bystander's own client triggering an award.
 *   4. A player FAR from that same event gets nothing.
 *
 *   node test-crafting-grouping-integration.js
 */
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const T = require('./public/terrain.js');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CWD = __dirname;
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
function waitReady(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stats' }, res => { res.resume(); resolve(); });
      req.on('error', () => { if (++tries > 120) return reject(new Error('server never came up on :' + port)); setTimeout(tick, 150); });
    };
    tick();
  });
}
function statsGet(port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
/** This hunter's {xp, level}, straight from the volatile-layer stats API, or null. */
async function hunterOf(port, key) {
  const tag = T.keyTag(key);
  const st = await statsGet(port);
  const h = (st.volatile && st.volatile.hunters || []).find(x => x.k === tag);
  return h ? { xp: h.xp, level: h.level } : null;
}

class Client {
  constructor(tag) { this.tag = tag; this.msgs = []; this.waiters = []; this.nodes = []; }
  connect(port) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port, path: '/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) return reject(new Error('bad accept key'));
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', d => this._feed(d));
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
    const scan = () => { for (let i = from; i < this.msgs.length; i++) if (test(this.msgs[i])) return this.msgs[i]; return null; };
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
  /** Walk toward (tx,ty), sending legal-sized steps, until within `within` tiles or time runs out. */
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
  console.log('\nSTRATUM crafting-XP + proximity-grouping integration — live server, real wire\n');
  const port = await freePort();
  if (port === 8090) { ok(false, 'refusing to run on the live server port 8090'); return; }
  const db = path.join(CWD, 'data', 'test-crafting-grouping.db');
  wipe(db);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: db, STRATUM_RESPAWN_SCALE: '0.02' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.log = ''; srv.exited = null;
  const cap = (d) => { srv.log += d.toString(); };
  srv.stdout.on('data', cap); srv.stderr.on('data', cap);
  srv.on('exit', (code, sig) => { srv.exited = code === null ? 'signal:' + sig : code; });
  await waitReady(port);
  const mustLive = () => { if (srv.exited !== null) { ok(false, 'test server died mid-suite', srv.exited); return false; } return true; };

  const KEY_A = 'group-key-AAAA-0001';   // the actor: harvests and crafts
  const KEY_B = 'group-key-BBBB-0002';   // the bystander: stays near, does nothing
  const KEY_C = 'group-key-CCCC-0003';   // the stranger: stays far, does nothing

  const A = new Client('A'), B = new Client('B'), C = new Client('C');
  await A.connect(port); await B.connect(port); await C.connect(port);

  A.send({ t: 'hello', key: KEY_A, name: 'ACTOR' });
  const wa = await A.waitFor(m => m.t === 'welcome');
  B.send({ t: 'hello', key: KEY_B, name: 'BYSTANDER' });
  await B.waitFor(m => m.t === 'welcome');
  C.send({ t: 'hello', key: KEY_C, name: 'STRANGER' });
  await C.waitFor(m => m.t === 'welcome');
  const sp = wa.spawn;   // A, B and C all spawn at the same point on a fresh map 0

  section('BASELINE — every hunter starts at 0 xp');
  const baseA = await hunterOf(port, KEY_A), baseB = await hunterOf(port, KEY_B), baseC = await hunterOf(port, KEY_C);
  ok((!baseA || baseA.xp === 0) && (!baseB || baseB.xp === 0) && (!baseC || baseC.xp === 0),
    'nobody has fought, harvested or crafted yet — nobody has XP', { baseA, baseB, baseC });

  section('GROUPING SETUP — C walks well outside GROUP_RADIUS, B stays put nearby');
  // B never moves: it stays exactly at spawn, close enough (<= GROUP_RADIUS) to any node
  // A can reach (REACH is smaller than GROUP_RADIUS), so B is the "someone nearby" case.
  // C walks 40 tiles away on the SAME map — well past GROUP_RADIUS but still close
  // enough to reach inside this test's time budget — so C is the "too far" control.
  const farD = await C.approach(sp.x + 40, sp.y, 3, 20000);
  ok(farD <= 3, 'the stranger walked ~40 tiles from spawn, off the shared event radius', farD);

  section('HARVEST — a successful harvest grants XP, not just materials');
  // A finds a ripe node close to spawn (same discovery pattern test-integration.js uses)
  // and harvests it to depletion.
  let node = null;
  for (let i = 0; i < 40 && !node; i++) {
    const p = A.pos();
    if (p) {
      let bd = 1e9, best = null;
      for (const n of A.nodes) {
        if (n.map !== 0 || n.state !== 1) continue;
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < bd) { bd = d; best = n; }
      }
      if (best && bd <= 40) node = best;
    }
    if (!node) await sleep(300);
  }
  ok(!!node, 'the world showed us a ripe node close to spawn', node && [node.x, node.y]);
  const dNode = await A.approach(node.x, node.y, 5, 20000);
  ok(dNode <= 5, 'A walked into harvest reach of the node', dNode);

  const preHarvestA = await hunterOf(port, KEY_A);
  let harvested = null, swings = 0;
  while (!harvested && swings < 10) {
    A.send({ t: 'harvest', x: node.x, y: node.y });
    const h = await A.waitNew(m => m.t === 'harvested' && m.x === node.x && m.y === node.y, 4000);
    swings++;
    if (h.gains) harvested = h;
    else if (h.err) break;
  }
  ok(!!harvested, 'A depleted the node and was credited with materials', { swings, harvested });
  await sleep(300);   // let the fan-out (world.awardXp + creditNearby) land before we poll stats
  const postHarvestA = await hunterOf(port, KEY_A);
  ok(postHarvestA && (!preHarvestA || postHarvestA.xp > preHarvestA.xp),
    'harvesting granted A XP directly, not just materials', { preHarvestA, postHarvestA });

  section('CRAFT — a successful craft grants XP');
  const preCraftA = await hunterOf(port, KEY_A);
  A.send({ t: 'craft', id: 'r_garden_bench' });   // cheap cozy decor recipe: {wood:3, herb:1}, tier 0
  const crafted = await A.waitNew(m => m.t === 'crafted' && m.id === 'r_garden_bench', 4000);
  ok(!crafted.err && crafted.item === 'garden_bench', 'A crafted a garden bench', crafted);
  await sleep(300);
  const postCraftA = await hunterOf(port, KEY_A);
  ok(postCraftA && (!preCraftA || postCraftA.xp > preCraftA.xp),
    'crafting granted A XP directly', { preCraftA, postCraftA });

  section('LIGHT GROUPING — proximity credit fans out from the harvest, once');
  const postHarvestB = await hunterOf(port, KEY_B);
  const postHarvestC = await hunterOf(port, KEY_C);
  ok(postHarvestB && postHarvestB.xp > 0, 'B (standing near the harvest, idle) was credited some XP without acting', postHarvestB);
  ok(postHarvestB && postHarvestA && postHarvestB.xp < postHarvestA.xp,
    'B\'s credit is a SHARE, strictly less than what A earned for the same harvest — never a duplicate full award',
    { actorHarvestXp: postHarvestA && postHarvestA.xp, bystanderXp: postHarvestB && postHarvestB.xp });
  ok(!postHarvestC || postHarvestC.xp === 0, 'C (far from the harvest) earned nothing', postHarvestC);

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  A.close(); B.close(); C.close();
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
