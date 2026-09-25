'use strict';
/**
 * test-tithes-integration.js — settler tithes, wired end to end.
 *
 * Seeds 60,000 pending via the DB-fixture technique, starts a Sable tithe for
 * the fixed 50,000 entry (100% treasury), proves the weekly upkeep sweep takes
 * its week (80/20 split) with a shortened STRATUM_TITHE_SWEEP_MS, proves lapse
 * when upkeep is unaffordable, and proves cancel. Boost math itself is pure
 * (Tithes.MULT) — here we prove the server reads live tithes per action by
 * checking welcome.tithes membership through start/cancel.
 *
 * Real server, real WebSocket clients, no mocks. Own DB, ephemeral port.
 *
 *   node test-tithes-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-tithes-integration.db');
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
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1', STRATUM_TITHE_SWEEP_MS: '1500' }, extraEnv || {}),
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

function getStats(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let body = '';
      r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async function main() {
  console.log('\nSTRATUM tithes integration — standing orders, upkeep sweep, lapse — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_A = 'tithe-key-AAAA-0001';
  const a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'TITHER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  let r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly to seed fixtures');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, 60000, 0, null, Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly after seeding 60000 pending');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'TITHER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.tokenPending === 60000, 'seeded balance survived', wa.tokenPending);
  ok(Array.isArray(wa.tithes) && wa.tithes.length === 0, 'no tithes yet', wa.tithes);

  // --------------------------------------------------------------------------
  section('START — 50000 entry, all treasury');
  // --------------------------------------------------------------------------
  a.send({ t: 'tithe-start', settler: 'ghost' });
  const bad = await a.waitNew(m => m.t === 'tithe-started');
  ok(bad.ok === false && bad.tokenPending === 60000, 'unknown settler refused, nothing spent', bad);

  a.send({ t: 'tithe-start', settler: 'sable' });
  const started = await a.waitNew(m => m.t === 'tithe-started' && m.ok === true);
  ok(started.price === 50000 && started.tokenPending === 10000, 'tithe started, pending 10000', started);
  ok(started.tithes && started.tithes.indexOf('sable') !== -1, 'response lists the tithe', started.tithes);

  a.send({ t: 'tithe-start', settler: 'sable' });
  const dup = await a.waitNew(m => m.t === 'tithe-started');
  ok(dup.ok === false && dup.err === 'already tithing' && dup.tokenPending === 10000, 'double-start refused', dup);

  const stats1 = await getStats(port);
  ok(stats1.treasury && stats1.treasury.STRATUM === 50000, 'entry went 100% to treasury', stats1.treasury);

  // --------------------------------------------------------------------------
  section('UPKEEP — weekly 100 via shortened sweep');
  // --------------------------------------------------------------------------
  // Backdate the tithe a full week so the next sweep (1.5s cadence) finds it due.
  a.close();
  await sleep(150);
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted to backdate upkeep');
  withDb(db => {
    db.prepare("UPDATE tithes SET lastUpkeepAt=? WHERE k=? AND settler='sable'").run(Date.now() - 8 * 24 * 3600 * 1000, KEY_A);
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted with a due tithe');
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'TITHER' });
  await a2.waitFor(m => m.t === 'welcome');
  const kept = await a2.waitNew(m => m.t === 'tithe-kept', 15000);
  ok(kept.paid === 100 && kept.burned === 80 && kept.treasury === 20, 'upkeep 100 split 80/20', kept);
  ok(kept.tokenPending === 9900, 'pending down exactly the upkeep', kept.tokenPending);

  // --------------------------------------------------------------------------
  section('LAPSE — unaffordable upkeep ends the tithe, takes nothing');
  // --------------------------------------------------------------------------
  a2.close();
  await sleep(150);
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  withDb(db => {
    db.prepare('UPDATE token_ledger SET pending=50 WHERE k=?').run(KEY_A);
    db.prepare("UPDATE tithes SET lastUpkeepAt=? WHERE k=? AND settler='sable'").run(Date.now() - 8 * 24 * 3600 * 1000, KEY_A);
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted poor with a due tithe');
  const a3 = new Client('A3', port);
  await a3.connect();
  a3.send({ t: 'hello', key: KEY_A, name: 'TITHER' });
  await a3.waitFor(m => m.t === 'welcome');
  const lapsed = await a3.waitNew(m => m.t === 'tithe-lapsed', 15000);
  ok(lapsed.settler === 'sable', 'unaffordable tithe lapsed', lapsed);
  a3.send({ t: 'tithe-start', settler: 'dray' });
  const poor = await a3.waitNew(m => m.t === 'tithe-started');
  ok(poor.ok === false && poor.tokenPending === 50, 're-start refused while poor', poor);

  // --------------------------------------------------------------------------
  section('CANCEL — free, immediate');
  // --------------------------------------------------------------------------
  withDb(db => {
    db.prepare('UPDATE token_ledger SET pending=60000 WHERE k=?').run(KEY_A);
  });
  // need a restart for the ledger write to be seen (server caches per-connection only —
  // ledgerOf reads the DB each call, so no restart needed for pending; but be safe)
  a3.send({ t: 'tithe-start', settler: 'ilo' });
  const started2 = await a3.waitNew(m => m.t === 'tithe-started' && m.ok === true);
  ok(started2.price === 50000, 'second tithe started after re-funding', started2.tokenPending);
  a3.send({ t: 'tithe-cancel', settler: 'ilo' });
  const cancelled = await a3.waitNew(m => m.t === 'tithe-cancelled');
  ok(cancelled.ok === true && cancelled.tithes.indexOf('ilo') === -1, 'cancel removes the tithe', cancelled);

  ok(mustLive(), 'the server never exited during the whole suite');
  a3.close();
  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1); });
