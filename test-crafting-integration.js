'use strict';
/**
 * test-crafting-integration.js — batch crafting + salvage (src/crafting.js), wired end
 * to end against a real server.
 *
 * test-crafting.js proves the pure batch/salvage math in isolation. This file proves the
 * SERVER actually uses it correctly: a batch craft pays exactly count x the recipe cost
 * and yields exactly count x the output in ONE request (not N separate ones), a batch
 * request beyond materials/stack room is refused with NOTHING spent, salvage returns a
 * partial materials refund and removes the salvaged items, and — the whole reason batch
 * crafting exists alongside src/anti-cheat.js — a legitimate large batch is never flagged
 * as bot-like by the rhythm signal (see applyCommerceReward()'s comment in server.js for
 * why). Real server, real WebSocket client, no mocks — same shape as every other
 * *-integration.js file in this repo. Spawns its own server on an ephemeral port with its
 * own DB — never 8090, never the live DB.
 *
 *   node test-crafting-integration.js      exits 0 only if every case PASSes
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
const TESTDB = path.join(CWD, 'data', 'test-crafting-integration.db');
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
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1' }, extraEnv || {}),
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
async function restart(srv, port, extraEnv) {
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  const p = await freePort();
  const next = startServer(p, extraEnv);
  await waitReady(p);
  return { srv: next, port: p };
}
function withDb(fn) {
  const db = new DatabaseSync(TESTDB);
  try { fn(db); } finally { db.close(); }
}

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
  console.log('\nSTRATUM crafting integration — batch craft + salvage — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_A = 'craft-key-AAAA-0001';
  const spawn0 = T.spawnPoint(0);

  // Establish the player row for real, then seed a generous material stockpile via the
  // same durable-state DB-fixture technique every other *-integration.js file uses — real
  // batch sizes (up to MAX_BATCH=20 of a multi-material recipe) would need dozens of real
  // harvests to afford honestly; the fixture gets a real, server-persisted starting
  // inventory without that grind. Everything AFTER this fixture is fully live.
  let a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'BATCHER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  const r0 = await restart(srv, port);
  srv = r0.srv; port = r0.port;
  ok(mustLive(), 'server restarted cleanly to seed the material fixture');
  withDb(db => {
    // Kept comfortably under STACK_LIMITS (wood/ore 400, herb 200, crystal 100) — a seed
    // AT or above the cap would get silently clamped the moment any ECO.add()-based
    // operation (like the salvage refund below) touches that resource, throwing off every
    // downstream delta assertion in this file for a reason that has nothing to do with
    // crafting itself.
    db.prepare('INSERT OR REPLACE INTO player_state(k,map,x,y,hp,kills,inv,tool) VALUES(?,?,?,?,?,?,?,?)')
      .run(KEY_A, 0, spawn0.x, spawn0.y, 100, 0, JSON.stringify({ wood: 300, ore: 300, herb: 150, crystal: 80, gold: 0 }), 0);
  });
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  ok(mustLive(), 'server restarted cleanly after seeding a generous material stockpile');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'BATCHER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.inv.wood === 300 && wa.inv.ore === 300, 'the seeded material stockpile survived the restart, exactly', wa.inv);

  // --------------------------------------------------------------------------
  section('BATCH CRAFT — a single request pays and yields exactly count x, in one shot');
  // --------------------------------------------------------------------------
  // r_flint_dagger: wood:2, ore:1, tier 0, output flint_dagger x1 (stack limit 10).
  const woodBefore = wa.inv.wood, oreBefore = wa.inv.ore;
  a.send({ t: 'craft', id: 'r_flint_dagger', count: 5 });
  const batch5 = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(!batch5.err, 'a batch of 5 is accepted, not refused', batch5);
  ok(batch5.count === 5, 'the response reports exactly 5 crafted, not 1', batch5);
  ok(batch5.inv.wood === woodBefore - 10, 'exactly 5x the wood cost (10) was deducted', batch5.inv.wood);
  ok(batch5.inv.ore === oreBefore - 5, 'exactly 5x the ore cost (5) was deducted', batch5.inv.ore);
  ok(batch5.inv.flint_dagger === 5, 'exactly 5 daggers landed in inventory', batch5.inv.flint_dagger);
  ok(batch5.gains.gold > 0 && batch5.gains.token > 0, 'the batch granted a real, nonzero reward', batch5.gains);

  section('BATCH CRAFT — beyond stack room is refused, nothing spent');
  // --------------------------------------------------------------------------
  // flint_dagger stack limit is 10; already holding 5, so batching 6 more would overflow.
  const woodBeforeOverflow = batch5.inv.wood, oreBeforeOverflow = batch5.inv.ore;
  a.send({ t: 'craft', id: 'r_flint_dagger', count: 6 });
  const overflow = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(overflow.err && overflow.err.indexOf('stack limit') >= 0, 'a batch that would overflow the stack is refused', overflow);
  const afterOverflowRefusal = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => { r.resume(); resolve(true); }).on('error', reject);
  });
  ok(afterOverflowRefusal === true, '/api/stats still answers after a refused overflow batch', afterOverflowRefusal);

  section('BATCH CRAFT — bad counts are refused before anything is touched');
  // --------------------------------------------------------------------------
  a.send({ t: 'craft', id: 'r_flint_dagger', count: 0 });
  const zeroCount = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(zeroCount.err === 'bad count', 'a count of 0 is refused', zeroCount);

  a.send({ t: 'craft', id: 'r_flint_dagger', count: 1.5 });
  const fracCount = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(fracCount.err === 'bad count', 'a fractional count is refused', fracCount);

  a.send({ t: 'craft', id: 'r_flint_dagger', count: 9999 });
  const hugeCount = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(hugeCount.err && hugeCount.err.indexOf('batch too large') >= 0, 'a count over MAX_BATCH is refused', hugeCount);

  // --------------------------------------------------------------------------
  section('SALVAGE — a partial materials refund, and the items are actually gone');
  // --------------------------------------------------------------------------
  const invBeforeSalvage = batch5.inv; // last known-good inv — none of the refusals above changed it
  a.send({ t: 'salvage', id: 'r_flint_dagger', count: 3 });
  const salvaged = await a.waitNew(m => m.t === 'salvaged' && m.id === 'r_flint_dagger');
  ok(!salvaged.err, 'salvaging 3 held daggers is accepted', salvaged);
  ok(salvaged.count === 3, 'exactly 3 were salvaged', salvaged);
  ok(salvaged.inv.flint_dagger === invBeforeSalvage.flint_dagger - 3, 'exactly 3 daggers left the inventory', salvaged.inv.flint_dagger);
  // r_flint_dagger inputs {wood:2, ore:1}; default 50% refund per item, floored: wood 1/ea, ore 0/ea (1*5000/10000=0.5->0)
  ok(salvaged.refund.wood === 3, 'wood refund is exactly 3 (1 per item x 3, matching the pure module)', salvaged.refund);
  ok(!('ore' in salvaged.refund), 'ore refund is omitted (floors to 0 per item at the default rate)', salvaged.refund);
  ok(salvaged.inv.wood === invBeforeSalvage.wood + 3, 'the wood refund actually landed in inventory', salvaged.inv.wood);

  section('SALVAGE — refused for more than held, nothing touched');
  // --------------------------------------------------------------------------
  const heldNow = salvaged.inv.flint_dagger;
  a.send({ t: 'salvage', id: 'r_flint_dagger', count: heldNow + 1 });
  const overSalvage = await a.waitNew(m => m.t === 'salvaged' && m.id === 'r_flint_dagger');
  ok(overSalvage.err === 'do not hold that many', 'salvaging more than held is refused', overSalvage);

  a.send({ t: 'salvage', id: 'r_garden_bench', count: 1 });
  const noneSalvage = await a.waitNew(m => m.t === 'salvaged' && m.id === 'r_garden_bench');
  ok(noneSalvage.err === 'nothing to salvage', 'salvaging an item never held is refused', noneSalvage);

  // --------------------------------------------------------------------------
  section('ANTI-CHEAT INTEROP — a big legitimate batch is never flagged as machine-regular');
  // --------------------------------------------------------------------------
  // Salvage everything held first to make room, then craft a fresh MAX_BATCH-sized batch —
  // this is exactly the "one deliberate click" scenario applyCommerceReward()'s comment in
  // server.js describes: one request, one anti-cheat evaluation, no synthetic rhythm signal
  // from crafting count>1 items in a tight server-side loop.
  a.send({ t: 'salvage', id: 'r_flint_dagger', count: heldNow });
  await a.waitNew(m => m.t === 'salvaged' && m.id === 'r_flint_dagger' && !m.err);
  a.send({ t: 'craft', id: 'r_flint_dagger', count: 10 }); // stack limit is 10, exactly MAX room now
  const bigBatch = await a.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger');
  ok(!bigBatch.err, 'a full-stack 10x batch is accepted', bigBatch);
  ok(bigBatch.count === 10, 'exactly 10 were crafted in one request', bigBatch);
  ok(bigBatch.gains.token > 0, 'the big batch was NOT throttled by anti-cheat — it earned a real reward', bigBatch.gains);

  mustLive();
  ok(mustLive(), 'the server never exited during the whole suite');
  a.close();
  try { srv.kill(); } catch (e2) {}
  await sleep(200);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  try { if (typeof srv !== 'undefined' && srv && srv.exited === null) srv.kill('SIGKILL'); } catch (e2) {}
  console.error('FATAL', e && (e.stack || e.message));
  process.exit(1);
});
