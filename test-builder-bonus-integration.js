/**
 * test-builder-bonus-integration.js — src/builder-bonus.js, wired end to end.
 *
 * test-builder-bonus.js proves the MODULE is pure and correct (tier math, boosting).
 * This file proves the SERVER actually uses it: a real player's `builderCount` on
 * `welcome` reflects what they actually own in the `structures` table (not just what's
 * in memory this session — it survives a restart), crossing a tier boundary by building
 * broadcasts a fresh `builder-tier` message with the right count/multiplier/name, tearing
 * a structure back down un-crosses it, and the whole thing never needs a per-action DB
 * scan (refreshBuilderBonus() only ever fires on hello/build/release — see server.js's
 * comment above it for why that discipline matters after the anti-cheat pending-aggregate
 * lag fix).
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-idle-integration.js
 * and test-walls-integration.js. Spawns its own server(s) on an ephemeral port with its
 * own DB (data/test-builder-bonus-integration.db) — never 8090, never the live DB.
 *
 *   node test-builder-bonus-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-builder-bonus-integration.db');
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
 *  test is allowed to touch the DB directly, exactly like test-idle-integration.js. */
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
  waitNew(test, ms) { return this.waitFrom(this.msgs.length, test, ms); }
  /** Same as waitNew, but `from` is an index the CALLER captured earlier (e.g. right
   *  before sending the triggering message) instead of "now" — two messages that arrive
   *  back-to-back in the same server tick (like 'built' then 'builder-tier') can both
   *  already be sitting in `msgs` by the time a second waitNew() call is made, and a
   *  fresh "now" index would skip right past the one it's supposed to catch. */
  waitFrom(from, test, ms) {
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
  console.log('\nSTRATUM builder-bonus integration — live server, real wire\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  const mustLive = () => { if (srv.exited !== null) { ok(false, 'test server died mid-suite', srv.exited); return false; } return true; };

  const KEY_A = 'builder-key-AAAA-0001';

  let a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'FOUNDER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  const map = wa.map, sp = wa.spawn;

  section('FRESH PLAYER — nobody starts with a bonus');
  ok(wa.builderCount === 0, 'welcome reports builderCount 0 for a brand-new colonist', wa.builderCount);
  ok(wa.builderMultiplier === 1.0, 'welcome reports the base 1.0x multiplier', wa.builderMultiplier);
  ok(wa.builderTier === 'Settler', 'welcome reports the base Settler tier', wa.builderTier);
  ok(wa.inv.wood === 6 && wa.inv.ore === 4, 'starter cache is wood:6, ore:4 — exactly one wall\'s price', wa.inv);

  const t1x = sp.x + 2, t1y = sp.y + 2;
  const t2x = sp.x - 2, t2y = sp.y - 2;

  section('BUILD ONE — below the Builder threshold (2), so still base tier');
  a.send({ t: 'set', x: t1x, y: t1y, m: 2 });               // 2 = grass, claim costs nothing
  await a.waitNew(m => m.t === 'you' && m.x === t1x && m.y === t1y, 4000);
  const from1 = a.msgs.length;                              // captured BEFORE sending — 'built' and
  a.send({ t: 'build-structure', x: t1x, y: t1y, kind: 'wall' }); // 'builder-tier' can both land before
  const built1 = await a.waitFrom(from1, m => m.t === 'built', 4000); // the next line even runs
  ok(built1 && !built1.err && built1.kind === 'wall', 'first wall built on A\'s own claimed land', built1);

  const tier1 = await a.waitFrom(from1, m => m.t === 'builder-tier', 4000);
  ok(tier1 && tier1.count === 1, 'builder-tier broadcast fires with count 1 right after the build', tier1);
  ok(tier1 && tier1.multiplier === 1.0 && tier1.tier === 'Settler',
    'one structure is still below the Builder threshold (2) — no bonus yet', tier1);

  section('BUILD TWO — top up resources for a second wall, restart, cross the threshold');
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  withDb(db => {
    const row = db.prepare('SELECT inv FROM player_state WHERE k=?').get(KEY_A);
    const inv = JSON.parse(row.inv);
    inv.wood += 10; inv.ore += 10;
    db.prepare('UPDATE player_state SET inv=? WHERE k=?').run(JSON.stringify(inv), KEY_A);
  });
  ok(mustLive(), 'server restarted cleanly to seed the second wall\'s cost');

  a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'FOUNDER' });
  const wa2 = await a.waitFor(m => m.t === 'welcome');
  ok(wa2.builderCount === 1, 'the first wall survived the restart — builderCount still 1 on reconnect', wa2.builderCount);
  ok(wa2.builderTier === 'Settler', 'still Settler on reconnect — restart did not spuriously bump the tier', wa2.builderTier);
  ok(wa2.inv.wood >= 10, 'the topped-up inventory survived the restart', wa2.inv);

  a.send({ t: 'set', x: t2x, y: t2y, m: 2 });
  await a.waitNew(m => m.t === 'you' && m.x === t2x && m.y === t2y, 4000);
  const from2 = a.msgs.length;
  a.send({ t: 'build-structure', x: t2x, y: t2y, kind: 'wall' });
  const built2 = await a.waitFrom(from2, m => m.t === 'built', 4000);
  ok(built2 && !built2.err, 'second wall built', built2);

  const tier2 = await a.waitFrom(from2, m => m.t === 'builder-tier', 4000);
  ok(tier2 && tier2.count === 2, 'builder-tier broadcast fires with count 2 after the second build', tier2);
  ok(tier2 && tier2.multiplier === 1.10 && tier2.tier === 'Builder',
    'crossing the threshold (2) flips the tier to Builder at 1.10x, matching src/builder-bonus.js\'s own table', tier2);

  section('RELEASE — tearing one back down un-crosses the threshold, live, no restart needed');
  const from3 = a.msgs.length;
  a.send({ t: 'release-structure', x: t1x, y: t1y });
  const released = await a.waitFrom(from3, m => m.t === 'structure-released' && !m.err, 4000);
  ok(!!released, 'the first wall was released', released);

  const tier3 = await a.waitFrom(from3, m => m.t === 'builder-tier', 4000);
  ok(tier3 && tier3.count === 1, 'builder-tier broadcast fires with count 1 again after the release', tier3);
  ok(tier3 && tier3.multiplier === 1.0 && tier3.tier === 'Settler',
    'the bonus reverts the instant the structure count drops back below threshold — currently owned, not a lifetime peak', tier3);

  section('THE SERVER SURVIVED THE WHOLE SUITE');
  ok(mustLive() && srv.exited === null, 'the server never crashed', srv.exited);

  a.close();
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
