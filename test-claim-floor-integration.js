'use strict';
/**
 * test-claim-floor-integration.js — the MIN_CLAIM_AMOUNT gas-floor on 'claim', wired end
 * to end, against the server's REAL default (no override) — test-commerce-integration.js
 * deliberately drops this floor to 1 so its own, unrelated claim-pipeline assertions can
 * use a single real harvest; this file is where the floor itself actually gets proven.
 *
 * WHY THE FLOOR EXISTS
 *   Real on-chain settlement (src/chain-adapter.js) pays gas for every settled claim from
 *   the treasury wallet — a 1-STRM claim costs the same gas as a 1000-STRM one. With no
 *   floor, a player (or a bot) could bleed the treasury's gas float one dust-sized claim
 *   at a time. See server.js's MIN_CLAIM_AMOUNT constant for the full reasoning.
 *
 * A large starting pending balance is seeded via the same durable-state DB-fixture
 * technique every other *-integration.js file in this repo uses (kill the server, edit
 * the row directly, reboot against the same DB) rather than grinding out real harvests —
 * see test-token-sink-integration.js's header for why that's the honest way to get a real,
 * server-persisted starting number without dozens of slow/flaky real actions. Every claim
 * request AFTER that seed is fully live, server-processed, never mocked.
 *
 *   node test-claim-floor-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-claim-floor-integration.db');
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
/** Server is down between kill and restart — the one window this test may touch the DB
 *  directly, mirroring every other restart-based integration test in this repo. */
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
  console.log('\nSTRATUM claim-floor integration — MIN_CLAIM_AMOUNT — live server, real wire, real default\n');
  wipe(TESTDB);
  const port0 = await freePort();
  // Deliberately NO STRATUM_MIN_CLAIM_AMOUNT override — this suite exists specifically to
  // prove the server's real, unoverridden default (see server.js).
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_A = 'floor-key-AAAA-0001';
  const WALLET_A = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  // Establish the player row for real (a genuine hello), then seed a pending STRM balance
  // just under the real default floor.
  let a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'DUSTCLAIMER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  section('SETUP — read the real default floor from /api/stats, seed a below-floor pending balance');
  const statsBefore = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let body = ''; r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const MIN_CLAIM = statsBefore.fees && statsBefore.fees.minClaim;
  ok(typeof MIN_CLAIM === 'number' && MIN_CLAIM > 0, '/api/stats reports a real, positive default minClaim', MIN_CLAIM);

  const BELOW = MIN_CLAIM - 1;
  const r0 = await restart(srv, port);
  srv = r0.srv; port = r0.port;
  ok(mustLive(), 'server restarted cleanly to seed the below-floor fixture');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, BELOW, 0, null, Date.now());
  });
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  ok(mustLive(), 'server restarted cleanly after seeding a below-floor pending STRM balance');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'DUSTCLAIMER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.tokenPending === BELOW, 'the seeded below-floor pending balance survived the restart, exactly', wa.tokenPending);

  a.send({ t: 'wallet-link', address: WALLET_A });
  await a.waitNew(m => m.t === 'wallet-linked' && !m.err);

  // --------------------------------------------------------------------------
  section('BELOW FLOOR — refused, nothing spent, nothing recorded');
  // --------------------------------------------------------------------------
  a.send({ t: 'claim' });
  const belowResult = await a.waitNew(m => m.t === 'claimed');
  ok(belowResult.ok === false, 'a below-floor claim is refused', belowResult);
  ok(belowResult.err === 'below minimum claim (' + MIN_CLAIM + ')', 'the refusal names the real floor exactly', belowResult);
  ok(belowResult.minClaim === MIN_CLAIM, 'the refusal echoes minClaim for the client to use', belowResult);
  ok(belowResult.tokenPending === BELOW, 'the refusal reports the untouched pending balance', belowResult);
  ok(belowResult.queued === undefined, 'a below-floor refusal is NOT the same shape as a queued/not_configured claim', belowResult);

  const statsAfterRefusal = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let body = ''; r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  ok(typeof statsAfterRefusal === 'object', '/api/stats still answers after a refused claim (server did not choke on it)', statsAfterRefusal);

  // --------------------------------------------------------------------------
  section('AT THE FLOOR — accepted into the real claim pipeline (not settled — no real chain configured), balance untouched');
  // --------------------------------------------------------------------------
  const r2 = await restart(srv, port);
  srv = r2.srv; port = r2.port;
  ok(mustLive(), 'server restarted cleanly to seed an at-floor fixture');
  withDb(db => {
    db.prepare('UPDATE token_ledger SET pending=? WHERE k=?').run(MIN_CLAIM, KEY_A);
  });
  const r3 = await restart(srv, port);
  srv = r3.srv; port = r3.port;
  ok(mustLive(), 'server restarted cleanly after seeding an at-floor pending STRM balance');

  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: KEY_A, name: 'DUSTCLAIMER' });
  const wb = await b.waitFor(m => m.t === 'welcome');
  ok(wb.tokenPending === MIN_CLAIM, 'the seeded at-floor pending balance survived the restart, exactly', wb.tokenPending);

  b.send({ t: 'claim' });
  const atFloorResult = await b.waitNew(m => m.t === 'claimed', 8000);
  ok(atFloorResult.err !== ('below minimum claim (' + MIN_CLAIM + ')'), 'an at-floor claim is NOT refused for being below the floor', atFloorResult);
  ok(atFloorResult.queued === true, 'an at-floor claim proceeds into the real (unsettled) claim pipeline', atFloorResult);
  ok(atFloorResult.amount === MIN_CLAIM, 'the claim amount matches the exact floor value', atFloorResult);
  ok(atFloorResult.tokenPending === MIN_CLAIM, 'an unsettled at-floor claim still leaves the pending balance untouched', atFloorResult);

  mustLive();
  ok(mustLive(), 'the server never exited during the whole suite');
  a.close(); b.close();
  try { srv.kill(); } catch (e2) {}
  await sleep(200);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  try { if (typeof srv !== 'undefined' && srv && srv.exited === null) srv.kill('SIGKILL'); } catch (e2) {}
  console.error('FATAL', e && (e.stack || e.message));
  process.exit(1);
});
