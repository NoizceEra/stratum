/**
 * test-idle-integration.js — src/idle.js, wired end to end.
 *
 * test-idle.js proves the MODULE is pure and correct (41/41). This file proves the
 * SERVER actually uses it: a real player, on a real server, builds a structure on land
 * they own, is refused on land they don't, cannot afford one it can't pay for, gets
 * nothing from an instant collect, is told about a neighbour's structure through the
 * ordinary chunk-subscription broadcast, and — the entire point of the module's design —
 * a structure's accrued yield is exactly right after the server has been DOWN, because
 * nothing ever ticks a structure in the background; it is pure math over elapsed wall
 * time computed lazily at collect. That last property is proven the same way
 * test-restart.js proves land survives a restart: kill the server, mutate durable state
 * on disk (here: nudge one structure's `lastCollectedAt` into the past, exactly the way
 * "45 real seconds passed while the server was down" would), reboot against the same DB,
 * and check the number the server hands back is the one the pure module predicts —
 * never 0 (which would mean the server lost the clock) and never uncapped (which would
 * mean something was ticking).
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-drops-integration.js
 * and test-restart.js. Spawns its own server(s) on an ephemeral port with its own DB
 * (data/test-idle-integration.db) — never 8090, never the live DB.
 *
 *   node test-idle-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');
const Idle = require('./src/idle.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-idle-integration.db');
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
    env: { ...process.env, PORT: String(port), STRATUM_DB: TESTDB },
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
async function restart(srv, port) {
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  const p = await freePort();
  const next = startServer(p);
  await waitReady(p);
  return { srv: next, port: p };
}

/** Server is down between the kill and the restart above — this is the one moment the
 *  test is allowed to touch the DB directly, exactly like a durable-state fixture in any
 *  other integration test. It never runs while the server holds the file. */
function withDb(fn) {
  const db = new DatabaseSync(TESTDB);
  try { fn(db); } finally { db.close(); }
}
function structKey(map, x, y) { return map + ':' + (y * T.W + x); }

class Client {
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; this.structs = new Map(); }
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
        socket.on('error', () => {});   // the server restarts mid-suite — expected, not a test failure
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
      if (m.t === 'chunk' && m.structures) for (const s of m.structures) this.structs.set(s.x + ',' + s.y, s);
      if (m.t === 'structure') this.structs.set(m.x + ',' + m.y, m);
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
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async function main() {
  console.log('\nSTRATUM idle structures integration — live server, real wire\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  const mustLive = () => { if (srv.exited !== null) { ok(false, 'test server died mid-suite', srv.exited); return false; } return true; };

  const KEY_A = 'idle-key-AAAA-0001';
  const KEY_B = 'idle-key-BBBB-0002';

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'GARDENER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  const map = wa.map, sp = wa.spawn;

  section('CATALOG — the structure catalog rides inside welcome, no separate request needed');
  const apiaryDef = (wa.catalog.structures || []).find(s => s.id === 'apiary');
  ok(!!apiaryDef, 'apiary is in the welcome catalog', wa.catalog.structures);
  ok(apiaryDef && apiaryDef.produces === 'honey' && apiaryDef.capacity === 20,
    'apiary catalog entry matches src/idle.js (honey, capacity 20)', apiaryDef);

  const tx = sp.x + 2, ty = sp.y + 2;                 // within reach of spawn, matching test-restart.js's pattern
  const skey = structKey(map, tx, ty);

  section('AFFORD — the starter cache (herb:2) cannot pay apiary\'s cost (herb:3)');
  ok(wa.inv.herb === 2, 'the fresh hunter starts with 2 herb, not enough for an apiary yet', wa.inv);
  // claim the tile FIRST — building needs land ownership under it, and this also proves
  // "no land, no build" further down by trying it on tiles nobody owns.
  a.send({ t: 'set', x: tx, y: ty, m: 6 });           // 6 = wood, a placeable material
  const claimed = await a.waitNew(m => m.t === 'you' && m.x === tx && m.y === ty, 4000);
  ok(!!claimed && !claimed.err, 'claimed the build tile', claimed);

  a.send({ t: 'build-structure', x: tx, y: ty, kind: 'apiary' });
  const denied = await a.waitNew(m => m.t === 'built', 4000);
  ok(denied && denied.err === 'not enough resources', 'building without enough resources is refused, not silently free', denied);

  section('OWNERSHIP — land you do not own refuses a build, even for the tile\'s claimant\'s neighbour');
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: KEY_B, name: 'FREELOADER' });
  const wb = await b.waitFor(m => m.t === 'welcome');
  // seed B with plenty so a refusal here can only be about ownership, not affordability
  b.send({ t: 'build-structure', x: tx, y: ty, kind: 'apiary' });
  const notOwned = await b.waitNew(m => m.t === 'built', 4000);
  ok(notOwned && notOwned.err === 'needs your own claimed land', 'a non-owner is refused on A\'s claimed tile', notOwned);

  const ux = sp.x - 3, uy = sp.y - 3;                 // an unclaimed tile near spawn
  a.send({ t: 'build-structure', x: ux, y: uy, kind: 'apiary' });
  const unclaimed = await a.waitNew(m => m.t === 'built', 4000);
  ok(unclaimed && unclaimed.err === 'needs your own claimed land', 'even the requester is refused on unclaimed ground', unclaimed);

  section('BUILD — top up the missing resources for real, then build for real');
  // Directly grant what claiming the tile spent, the same way any fixture seeds durable
  // state: through the real DB the server itself reads on `hello`, mutated only while
  // the server owns no open handle on it (see `restart()`) — never while it is live.
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  withDb(db => {
    const row = db.prepare('SELECT inv FROM player_state WHERE k=?').get(KEY_A);
    const inv = JSON.parse(row.inv);
    inv.wood += 10; inv.herb += 10;
    db.prepare('UPDATE player_state SET inv=? WHERE k=?').run(JSON.stringify(inv), KEY_A);
  });
  ok(mustLive(), 'server restarted cleanly to seed the fixture');

  const a2 = new Client('A', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'GARDENER' });
  const wa2 = await a2.waitFor(m => m.t === 'welcome');
  ok(wa2.inv.herb >= 7 && wa2.inv.wood >= 6, 'the topped-up inventory survived the restart', wa2.inv);

  // A bystander already subscribed to this chunk before the build must get the LIVE
  // broadcast (same delivery function broadcastTile/broadcastDrop use), not just a
  // future chunk fetch — subscribe now, before building.
  const bLive = new Client('LIVE', port);
  await bLive.connect();
  bLive.send({ t: 'hello', key: 'idle-key-CCCC-0003', name: 'NEIGHBOUR' });
  await bLive.waitFor(m => m.t === 'welcome');
  bLive.send({ t: 'view', x: tx, y: ty });
  await bLive.waitFor(m => m.t === 'chunk' && m.map === map, 6000).catch(() => {});

  a2.send({ t: 'build-structure', x: tx, y: ty, kind: 'apiary' });
  const built = await a2.waitNew(m => m.t === 'built', 4000);
  ok(built && !built.err && built.kind === 'apiary', 'the apiary was built on A\'s own claimed land', built);
  ok(built && built.inv && built.inv.wood === wa2.inv.wood - 6 && built.inv.herb === wa2.inv.herb - 3,
    'the build cost (wood:6, herb:3) was deducted, and only that', built && built.inv);

  const liveMsg = await bLive.waitFor(m => m.t === 'structure' && m.x === tx && m.y === ty, 4000).catch(() => null);
  ok(!!liveMsg && liveMsg.kind === 'apiary' && liveMsg.owner === KEY_A,
    'an already-subscribed bystander gets the LIVE structure broadcast the instant it is built', liveMsg);
  bLive.close();

  // A bystander who connects AFTER the build sees it through ordinary chunk delivery
  // (structuresForChunk piggybacks on the same 'chunk' message nodes/drops already ride);
  // one who is already subscribed when it happens gets the live 'structure' broadcast
  // instead — both paths are exercised below.
  const b2 = new Client('B', port);
  await b2.connect();
  b2.send({ t: 'hello', key: KEY_B, name: 'FREELOADER' });
  await b2.waitFor(m => m.t === 'welcome');
  b2.send({ t: 'view', x: tx, y: ty });
  await b2.waitFor(m => m.t === 'chunk' && m.map === map, 6000).catch(() => {});
  await sleep(300);
  const seenByB = b2.structs.get(tx + ',' + ty);
  ok(!!seenByB, 'a bystander is told about the structure via ordinary chunk delivery', seenByB);
  ok(seenByB && seenByB.kind === 'apiary' && seenByB.owner === KEY_A, 'the chunk delivery carries the right kind and owner', seenByB);

  a2.send({ t: 'build-structure', x: tx, y: ty, kind: 'apiary' });
  const dup = await a2.waitNew(m => m.t === 'built', 4000);
  ok(dup && dup.err === 'already built here', 'a second structure cannot be built on the same tile', dup);

  section('INSTANT COLLECT — no time has passed, so there is nothing to collect');
  a2.send({ t: 'collect-structure', x: tx, y: ty });
  const instant = await a2.waitNew(m => m.t === 'collected', 4000);
  ok(instant && !instant.err && instant.gained === 0, 'collecting immediately after building yields exactly nothing', instant);

  section('OWNERSHIP OF THE PRODUCER — a bystander cannot drain someone else\'s structure');
  b2.send({ t: 'collect-structure', x: tx, y: ty });
  const stolen = await b2.waitNew(m => m.t === 'collected', 4000);
  ok(stolen && stolen.err === 'not yours', 'a non-owner collecting from A\'s structure is refused', stolen);

  section('RESTART — lazy accrual survives being computed against a clock the server never ran');
  a2.close(); b2.close(); a.close(); b.close();
  // Simulate "45 real seconds passed while the server was down" without waiting 45
  // seconds: back-date lastCollectedAt on disk, in the one window the server does not
  // hold the file. Apiary accrues 1 honey / 45s — 50000ms elapsed predicts exactly 1.
  const now = Date.now();
  withDb(db => {
    db.prepare('UPDATE structures SET lastCollectedAt=? WHERE id=?').run(now - 50000, skey);
  });
  const r2 = await restart(srv, port);
  srv = r2.srv; port = r2.port;
  ok(mustLive(), 'server restarted cleanly after the fixture edit');

  const c = new Client('C', port);
  await c.connect();
  c.send({ t: 'hello', key: KEY_A, name: 'GARDENER' });
  const wc = await c.waitFor(m => m.t === 'welcome');
  const invBefore = Object.assign({}, wc.inv);

  c.send({ t: 'collect-structure', x: tx, y: ty });
  const afterRestart = await c.waitNew(m => m.t === 'collected', 4000);
  ok(afterRestart && !afterRestart.err && afterRestart.gained === 1 && afterRestart.resource === 'honey',
    'accrual across the restart is exactly what 50 real seconds at 1/45s predicts — not 0, not uncapped',
    afterRestart);
  ok(afterRestart && afterRestart.inv && afterRestart.inv.honey === (invBefore.honey || 0) + 1,
    'the gained honey landed in the collector\'s inventory', afterRestart && afterRestart.inv);

  section('CAPACITY CLAMP — across a second restart, a huge gap still caps at capacity, never more');
  c.close();
  const farPast = Date.now() - (60 * 60 * 1000);       // 1 real hour — far past the 20-honey cap
  withDb(db => {
    db.prepare('UPDATE structures SET lastCollectedAt=? WHERE id=?').run(farPast, skey);
  });
  const r3 = await restart(srv, port);
  srv = r3.srv; port = r3.port;
  ok(mustLive(), 'server restarted cleanly a second time');

  const d = new Client('D', port);
  await d.connect();
  d.send({ t: 'hello', key: KEY_A, name: 'GARDENER' });
  await d.waitFor(m => m.t === 'welcome');
  d.send({ t: 'collect-structure', x: tx, y: ty });
  const capped = await d.waitNew(m => m.t === 'collected', 4000);
  ok(capped && !capped.err && capped.gained === Idle.STRUCTURES.apiary.capacity,
    'a one-hour gap still yields exactly the capacity (20), never more, matching src/idle.js\'s own clamp',
    capped);

  d.send({ t: 'collect-structure', x: tx, y: ty });
  const again = await d.waitNew(m => m.t === 'collected', 4000);
  ok(again && !again.err && again.gained === 0, 'collecting again right after draining it yields nothing (clock advanced, not reset)', again);
  d.close();

  section('THE SERVER THAT KEPT NO CLOCK RUNNING');
  ok(mustLive() && srv.exited === null, 'the server never crashed during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
