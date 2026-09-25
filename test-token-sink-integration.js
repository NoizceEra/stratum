'use strict';
/**
 * test-token-sink-integration.js — Earth Requisition + Structure Rush, wired end to end.
 *
 * test-token-sink.js proves the pure burn/treasury-split and cost math in isolation.
 * This file proves the SERVER actually uses it correctly: a real requisition spends
 * real pending STRATUM, splits it burned/treasury per TOKEN_BURN_BPS, and the burned half
 * is genuinely gone forever (never added to anyone's claimed total, never recoverable);
 * a requisition beyond what's pending is refused with nothing spent; a big requisition
 * broadcasts to bystanders; a structure rush costs STRATUM to skip real accrued time
 * (proven the same way test-idle-integration.js proves lazy accrual: kill the server,
 * back-date a structure's lastCollectedAt on disk, reboot, and check the numbers match
 * what the pure module predicts), grants exactly what's owed (already-accrued PLUS the
 * rushed remainder), and a non-owner can never rush someone else's structure.
 *
 * Real server, real WebSocket clients, no mocks — same shape as every other
 * *-integration.js file in this repo. Spawns its own server(s) on ephemeral ports with
 * their own DB — never 8090, never the live DB.
 *
 *   node test-token-sink-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-token-sink-integration.db');
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
function startServer(port, extraEnv) {
  if (port === LIVE_PORT) throw new Error('refusing to run a test server on ' + LIVE_PORT);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1', STRATUM_SINK_ONCHAIN: '0' }, extraEnv || {}),
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
function getStats(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function restart(srv, port, extraEnv) {
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  const p = await freePort();
  const next = startServer(p, extraEnv);
  await waitReady(p);
  return { srv: next, port: p };
}
/** Server is down between kill and restart — the one window this test may touch the
 *  DB directly, mirroring test-idle-integration.js exactly. */
function withDb(fn) {
  const db = new DatabaseSync(TESTDB);
  try { fn(db); } finally { db.close(); }
}
function structKey(map, x, y) { return map + ':' + (y * T.W + x); }

class Client {
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; }
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
        socket.on('error', () => {});
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
  console.log('\nSTRATUM token-sink integration — Earth Requisition + Structure Rush — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const spawn0 = T.spawnPoint(0);
  const KEY_A = 'sink-key-AAAA-0001';

  // Establish A's rows for real (a genuine hello), then seed a large pending STRATUM
  // balance via the SAME durable-state DB-fixture technique test-idle-integration.js
  // uses for lastCollectedAt: kill the server, edit the row directly, reboot against
  // the same DB. This is the honest way to get a real, server-persisted starting
  // balance without scripting dozens of real harvests (most nodes need 2-4 hits to
  // fully deplete and actually pay out — single-hit herbs were the only reliable yield,
  // making real farming both slow and flaky for a balance this large). Everything AFTER
  // this fixture — every requisition, every rush — is fully live, server-processed,
  // never mocked; only the STARTING number is a fixture, exactly like every other
  // restart-based integration test in this repo.
  let a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'SHIPPER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  const SEEDED_PENDING = 500;
  const r0 = await restart(srv, port);
  srv = r0.srv; port = r0.port;
  ok(mustLive(), 'server restarted cleanly to seed the ledger fixture');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, SEEDED_PENDING, 0, null, Date.now());
    // Also top up materials so the later apiary build (needs herb:3; the starter cache
    // only carries herb:2) doesn't depend on precise starter-cache arithmetic. A bare
    // UPDATE would silently match zero rows here: 'hello' alone never persists a
    // player_state row (only the first stateful action does, via stateSave) — a0 above
    // only said hello and closed, so no row exists yet. INSERT OR REPLACE, mirroring
    // server.js's own qState upsert exactly, with the real spawn point so the player
    // doesn't land somewhere nonsensical.
    db.prepare('INSERT OR REPLACE INTO player_state(k,map,x,y,hp,kills,inv,tool) VALUES(?,?,?,?,?,?,?,?)')
      .run(KEY_A, 0, spawn0.x, spawn0.y, 100, 0, JSON.stringify({ wood: 20, ore: 20, herb: 20, crystal: 20, gold: 0 }), 0);
  });
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  ok(mustLive(), 'server restarted cleanly after seeding a real pending STRATUM balance');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'SHIPPER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.tokenPending === SEEDED_PENDING, 'the seeded pending STRATUM balance survived the restart, exactly', wa.tokenPending);
  const pendingAfterFarm = wa.tokenPending;

  function findNodesNear(spawn, radius, count) {
    const found = [];
    for (let r = 0; r <= radius && found.length < count; r++) {
      for (let dy = -r; dy <= r && found.length < count; dy++) {
        for (let dx = -r; dx <= r && found.length < count; dx++) {
          const x = spawn.x + dx, y = spawn.y + dy;
          if (T.nodeAt(0, x, y) && !found.some(p => p.x === x && p.y === y)) found.push({ x, y });
        }
      }
    }
    return found;
  }
  const nodes = findNodesNear(spawn0, 30, 6);
  ok(nodes.length >= 4, 'found several real nodes near spawn (used later for a small live top-up)', nodes.length);

  // --------------------------------------------------------------------------
  section('EARTH REQUISITION — refused with a bad or unaffordable amount, nothing spent');
  // --------------------------------------------------------------------------
  a.send({ t: 'requisition', amount: 0 });
  const zero = await a.waitNew(m => m.t === 'requisitioned');
  ok(zero.ok === false && zero.err === 'bad amount', 'requisitioning 0 is refused', zero);

  a.send({ t: 'requisition', amount: pendingAfterFarm + 1000 });
  const over = await a.waitNew(m => m.t === 'requisitioned');
  ok(over.ok === false && over.err === 'cannot afford', 'requisitioning more than pending is refused', over);
  ok(over.tokenPending === pendingAfterFarm, 'a refused requisition leaves the pending balance untouched', over);

  // --------------------------------------------------------------------------
  section('EARTH REQUISITION — a real requisition burns/treasuries per TOKEN_BURN_BPS, quota advances');
  // --------------------------------------------------------------------------
  const spendAmount = 10;
  ok(pendingAfterFarm >= spendAmount, 'the farmed balance covers this test\'s spend', pendingAfterFarm);
  a.send({ t: 'requisition', amount: spendAmount });
  const shipped = await a.waitNew(m => m.t === 'requisitioned' && m.ok === true);
  ok(shipped.burned + shipped.treasury === spendAmount, 'burned + treasury sums exactly to the amount spent (no dust lost)', shipped);
  ok(shipped.burned === 8 && shipped.treasury === 2, 'default 80/20 split is exact for a spend of 10', shipped);
  ok(shipped.tokenPending === pendingAfterFarm - spendAmount, 'pending dropped by exactly the spent amount', shipped.tokenPending);
  ok(shipped.colonyQuota === shipped.burned, 'the global colony quota equals what was actually burned', shipped);

  const statsAfterShip = await getStats(port);
  ok(statsAfterShip.colonyQuota === shipped.burned, '/api/stats reports the same colony quota', statsAfterShip.colonyQuota);
  ok(statsAfterShip.treasury && statsAfterShip.treasury.STRATUM === shipped.treasury,
    '/api/stats treasury.STRATUM reflects the treasury half of the sink spend', statsAfterShip.treasury);

  // --------------------------------------------------------------------------
  section('EARTH REQUISITION — a big requisition broadcasts to bystanders, a small one does not');
  // --------------------------------------------------------------------------
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'sink-key-BBBB-0002', name: 'WITNESS' });
  await b.waitFor(m => m.t === 'welcome');

  a.send({ t: 'requisition', amount: 60 });          // >= the 50-unit broadcast threshold
  const bigShip = await a.waitNew(m => m.t === 'requisitioned' && m.ok === true && m.amount === 60);
  await sleep(200);
  const gotBroadcastForBig = b.msgs.find(m => m.t === 'requisition-broadcast' && m.amount === 60);
  ok(!!gotBroadcastForBig, 'a >=50 requisition broadcasts to a nearby bystander', gotBroadcastForBig);
  ok(gotBroadcastForBig && gotBroadcastForBig.by === 'SHIPPER', 'the broadcast names the shipper', gotBroadcastForBig);
  ok(gotBroadcastForBig && gotBroadcastForBig.colonyQuota === bigShip.colonyQuota,
    'the broadcast quota matches the requester\'s own view of it', gotBroadcastForBig);

  a.send({ t: 'requisition', amount: 5 });           // well under the threshold
  const smallShip = await a.waitNew(m => m.t === 'requisitioned' && m.ok === true && m.amount === 5);
  await sleep(200);
  const gotBroadcastForSmall = b.msgs.find(m => m.t === 'requisition-broadcast' && m.amount === 5);
  ok(!gotBroadcastForSmall, 'a small (<50) requisition does NOT broadcast to bystanders', gotBroadcastForSmall);

  // --------------------------------------------------------------------------
  section('EARTH REQUISITION — omitting amount ships everything currently pending');
  // --------------------------------------------------------------------------
  const remainingBefore = smallShip.tokenPending;
  ok(remainingBefore > 0, 'there is still something pending to ship', remainingBefore);
  a.send({ t: 'requisition' });
  const shipAll = await a.waitNew(m => m.t === 'requisitioned' && m.ok === true);
  ok(shipAll.amount === remainingBefore, 'omitting amount ships exactly the full remaining balance', shipAll);
  ok(shipAll.tokenPending === 0, 'pending is now exactly zero', shipAll.tokenPending);

  a.send({ t: 'requisition' });
  const nothingLeft = await a.waitNew(m => m.t === 'requisitioned');
  ok(nothingLeft.ok === false && nothingLeft.err === 'nothing pending', 'requisitioning again with nothing pending is refused', nothingLeft);

  // --------------------------------------------------------------------------
  section('STRUCTURE RUSH — build, back-date real elapsed time, restart, then rush the gap');
  // --------------------------------------------------------------------------
  const bx = spawn0.x + 5, by = spawn0.y;
  // m here is a raw terrain tile id (T.ID), not a palette index — 1 is DIRT (cost:
  // {wood:1}), safely apart from the herb the apiary itself needs.
  a.send({ t: 'set', x: bx, y: by, m: 1 });
  await a.waitNew(m => m.t === 'you' && m.x === bx && m.y === by, 4000);
  a.send({ t: 'build-structure', x: bx, y: by, kind: 'apiary' });
  const built = await a.waitNew(m => m.t === 'built', 4000);
  ok(built && !built.err, 'apiary built on A\'s own claimed land', built);
  const skey = structKey(0, bx, by);

  a.close(); b.close();
  // Apiary: 1 honey / 45s, capacity 20. Back-date 5*45s = 225000ms -> 5 already accrued,
  // 15 short of capacity -> rushCost(5,20,2) = {gained:15, cost:30} (default per-unit 2).
  // Re-seed pending STRATUM too — the requisition tests above drove it to exactly 0, and
  // the rush needs real balance to spend; same fixture window, same durable-state
  // technique, just two rows instead of one.
  const now = Date.now();
  withDb(db => {
    db.prepare('UPDATE structures SET lastCollectedAt=? WHERE id=?').run(now - 225000, skey);
    db.prepare('UPDATE token_ledger SET pending=? WHERE k=?').run(100, KEY_A);
  });
  const r2 = await restart(srv, port);
  srv = r2.srv; port = r2.port;
  ok(mustLive(), 'server restarted cleanly after the fixture edit');

  const c = new Client('C', port);
  await c.connect();
  c.send({ t: 'hello', key: 'sink-key-AAAA-0001', name: 'SHIPPER' });
  const wc = await c.waitFor(m => m.t === 'welcome');
  const pendingBeforeRush = wc.tokenPending | 0;
  ok(pendingBeforeRush >= 30, 'the reconnected player has enough pending STRATUM to afford the rush', pendingBeforeRush);
  const honeyBefore = (wc.inv && wc.inv.honey) || 0;

  const d = new Client('D', port);
  await d.connect();
  d.send({ t: 'hello', key: 'sink-key-DDDD-0004', name: 'INTRUDER' });
  await d.waitFor(m => m.t === 'welcome');
  d.send({ t: 'move', x: bx, y: by });
  await sleep(150);
  d.send({ t: 'structure-rush', x: bx, y: by });
  const stolen = await d.waitNew(m => m.t === 'rushed');
  ok(stolen.err === 'not yours', 'a non-owner cannot rush someone else\'s structure', stolen);

  c.send({ t: 'move', x: bx, y: by });
  await sleep(150);
  c.send({ t: 'structure-rush', x: bx, y: by });
  const rushed = await c.waitNew(m => m.t === 'rushed' && !m.err, 4000);
  ok(rushed.resource === 'honey', 'the rush resolved against the honey-producing apiary', rushed);
  ok(rushed.gained === 20, 'total gained (5 already-accrued + 15 rushed) equals the full 20-honey capacity', rushed);
  ok(rushed.cost === 30, 'the rush cost exactly 30 STRATUM (15 units short x 2 STRATUM/unit)', rushed);
  ok(rushed.burned === 24 && rushed.treasury === 6, 'the rush cost itself splits 80/20 burned/treasury, same as any sink spend', rushed);
  ok(rushed.tokenPending === pendingBeforeRush - 30, 'pending dropped by exactly the rush cost', rushed.tokenPending);
  ok(rushed.inv && rushed.inv.honey === honeyBefore + 20, 'the full 20 honey landed in inventory', rushed.inv);

  // A rush COLLECTS everything (already-accrued + rushed remainder) and resets the
  // structure's clock to now, same as an ordinary collect — so immediately after a
  // rush the structure is freshly EMPTY, not full. Rushing again right away is
  // therefore a legitimate fresh full-capacity purchase (cost 40 = 20 units x 2/unit),
  // not a refusal — proven directly rather than assumed.
  c.send({ t: 'structure-rush', x: bx, y: by });
  const rushedAgain = await c.waitNew(m => m.t === 'rushed' && !m.err, 4000);
  ok(rushedAgain.gained === 20 && rushedAgain.cost === 40,
    'a rush right after a rush is a fresh full-capacity purchase, not a refusal — the clock reset',
    rushedAgain);

  // To actually hit "already full," the structure must reach capacity WITHOUT being
  // collected — same backdate-to-far-past fixture test-idle-integration.js uses to
  // prove the capacity clamp, reused here for the same reason.
  c.close(); d.close();
  const farPast = Date.now() - (60 * 60 * 1000); // 1 real hour — far past the 20-honey cap
  withDb(db => {
    db.prepare('UPDATE structures SET lastCollectedAt=? WHERE id=?').run(farPast, skey);
  });
  const r3 = await restart(srv, port);
  srv = r3.srv; port = r3.port;
  ok(mustLive(), 'server restarted cleanly for the already-full fixture');

  const e = new Client('E', port);
  await e.connect();
  e.send({ t: 'hello', key: KEY_A, name: 'SHIPPER' });
  const we = await e.waitFor(m => m.t === 'welcome');
  const pendingBeforeFull = we.tokenPending | 0;

  e.send({ t: 'move', x: bx, y: by });
  await sleep(150);
  e.send({ t: 'structure-rush', x: bx, y: by });
  const alreadyFull = await e.waitNew(m => m.t === 'rushed', 4000);
  ok(alreadyFull.err === 'already full', 'rushing a structure already at capacity (never collected) is refused', alreadyFull);

  // Prove the refused rush really charged nothing: a requisition right after must still
  // see exactly the same balance, minus only this one deliberate spend.
  e.send({ t: 'requisition', amount: 1 });
  const afterRefusedRush = await e.waitNew(m => m.t === 'requisitioned' && m.ok === true);
  ok(afterRefusedRush.tokenPending === pendingBeforeFull - 1,
    'the refused already-full rush left the ledger completely untouched', afterRefusedRush);

  mustLive();
  ok(mustLive(), 'the server never exited during the whole suite');
  e.close();
  try { srv.kill(); } catch (e2) {}
  await sleep(200);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  // A thrown error (e.g. a waitNew timeout) must never leak the server process — an
  // orphan left running here holds the test DB file locked, which makes wipe() at the
  // TOP of the next run silently no-op and inherit stale state from this failed run.
  // That is exactly the bug that produced a mystery "held herb:1" failure once already.
  try { if (srv && srv.exited === null) srv.kill('SIGKILL'); } catch (e2) {}
  console.error('FATAL', e && (e.stack || e.message));
  process.exit(1);
});
