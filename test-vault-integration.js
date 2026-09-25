'use strict';
/**
 * test-vault-integration.js — STRATUM vault, wired end to end.
 *
 * Deposit (1% in) / withdraw (2.5% out) with real pending, weekly GLDX
 * emission pro-rata via a backdated kitty week + shortened sweep, TVL on
 * /api/stats. Real server, real wire, own DB, ephemeral port.
 *
 *   node test-vault-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-vault-integration.db');
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
  srv.exited = null;
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
function getStats(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let body = '';
      r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
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
  console.log('\nSTRATUM vault integration — stake, unstake, weekly GLDX emission — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_A = 'vault-key-AAAA-0001';
  const a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'VAULTER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  let r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly to seed fixtures');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, 1000, 0, null, Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly after seeding 1000 pending');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'VAULTER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.tokenPending === 1000 && (wa.vault | 0) === 0, 'seeded balance, empty vault', wa.tokenPending);

  // --------------------------------------------------------------------------
  section('DEPOSIT — 1% in, WITHDRAW — 2.5% out');
  // --------------------------------------------------------------------------
  a.send({ t: 'vault-deposit', amount: 50 });
  const small = await a.waitNew(m => m.t === 'vault-deposited');
  ok(small.ok === false && small.tokenPending === 1000, 'below-minimum deposit refused', small);

  a.send({ t: 'vault-deposit', amount: 500 });
  const dep = await a.waitNew(m => m.t === 'vault-deposited' && m.ok === true);
  ok(dep.gross === 500 && dep.fee === 5 && dep.net === 495, 'deposit 500: fee 5, net 495', dep);
  ok(dep.vault === 495 && dep.tokenPending === 500, 'vault 495, pending 500', dep);

  a.send({ t: 'vault-withdraw', amount: 95 });
  const wd = await a.waitNew(m => m.t === 'vault-withdrawn' && m.ok === true);
  ok(wd.gross === 95 && wd.fee === 2 && wd.net === 93, 'withdraw 95: fee 2, net 93', wd);
  ok(wd.vault === 400 && wd.tokenPending === 593, 'vault 400, pending 593', wd);

  a.send({ t: 'vault-withdraw', amount: 9999 });
  const over = await a.waitNew(m => m.t === 'vault-withdrawn');
  ok(over.ok === false && over.vault === 400, 'over-withdrawal refused', over);

  const stats1 = await getStats(port);
  ok(stats1.economy && stats1.economy.vault && stats1.economy.vault.tvl === 400 &&
    stats1.economy.vault.depositors === 1, 'TVL 400, 1 depositor on /api/stats', stats1.economy.vault);
  ok(stats1.treasury && stats1.treasury.STRATUM === 7, 'treasury holds 5+2 in fees', stats1.treasury);

  // --------------------------------------------------------------------------
  section('EMISSION — weekly GLDX pro-rata to the sole depositor');
  // --------------------------------------------------------------------------
  a.close();
  await sleep(150);
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  withDb(db => {
    db.prepare("INSERT INTO token_burned(id,total,updated) VALUES('vault_kitty_week',0,?) " +
      'ON CONFLICT(id) DO UPDATE SET total=0').run(Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted with a stale kitty week');
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'VAULTER' });
  const wa2 = await a2.waitFor(m => m.t === 'welcome');
  // emission fires on the 1.5s sweep; welcome may arrive before or after — accept either,
  // then confirm the credit landed.
  await sleep(4000);
  const a3 = new Client('A3', port);
  await a3.connect();
  a3.send({ t: 'hello', key: KEY_A, name: 'VAULTER' });
  const wa3 = await a3.waitFor(m => m.t === 'welcome');
  ok((wa3.gldxPending | 0) === 25000, 'sole depositor got the full 25000 emission', wa3.gldxPending);

  ok(mustLive(), 'the server never exited during the whole suite');
  a2.close(); a3.close();
  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1); });
