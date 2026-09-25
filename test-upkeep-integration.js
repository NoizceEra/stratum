'use strict';
/**
 * test-upkeep-integration.js — land upkeep burn + quota dividends, end to end.
 *
 * Seeds land (3 real placements), pending, and a treasury vault balance, then
 * backdates the upkeep week so the shortened sweep processes it: upkeep burns
 * 2/tile from pending, dividends pay tiles*1 from the vault (fee stays in).
 * Real server, real wire, own DB, ephemeral port.
 *
 *   node test-upkeep-integration.js      exits 0 only if every case PASSes
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
const TESTDB = path.join(CWD, 'data', 'test-upkeep-integration.db');
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
  console.log('\nSTRATUM upkeep integration — weekly burn + dividends — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const spawn0 = T.spawnPoint(0);
  const KEY_A = 'upkeep-key-AAAA-0001';
  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'HOLDER' });
  await a.waitFor(m => m.t === 'welcome');

  // Claim 3 real tiles (tile id 1 costs wood, starter holds 6).
  const spots = [[1, 0], [2, 0], [1, 1]];
  for (const [dx, dy] of spots) {
    a.send({ t: 'set', x: spawn0.x + dx, y: spawn0.y + dy, m: 1 });
    const you = await a.waitNew(m => m.t === 'you' || m.t === 'deny');
    if (you.t !== 'you') { ok(false, 'placement accepted', you); break; }
  }
  ok(mustLive(), 'claimed 3 tiles live');

  // Seed pending 100 + vault 1000, backdate the upkeep week, reboot.
  a.close();
  await sleep(150);
  let r = await restart(srv, port);
  srv = r.srv; port = r.port;
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, 100, 0, null, Date.now());
    db.prepare("INSERT INTO treasury(item,qty,updated) VALUES('STRATUM',1000,?) " +
      'ON CONFLICT(item) DO UPDATE SET qty=1000').run(Date.now());
    db.prepare("INSERT INTO token_burned(id,total,updated) VALUES('upkeep_week',0,?) " +
      'ON CONFLICT(id) DO UPDATE SET total=0').run(Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted with seeded fixtures and a stale upkeep week');

  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'HOLDER' });
  await a2.waitFor(m => m.t === 'welcome');
  // upkeep (3 tiles * 2 = 6 burned) + dividend (3 tiles * 1 = 3, fee 0) land
  // within a few sweep ticks; the dividend push is the observable signal.
  const div = await a2.waitNew(m => m.t === 'dividend', 15000);
  ok(div.net === 3, 'dividend paid 3 for 3 tiles', div);

  await sleep(1000);
  const a3 = new Client('A3', port);
  await a3.connect();
  a3.send({ t: 'hello', key: KEY_A, name: 'HOLDER' });
  const wa3 = await a3.waitFor(m => m.t === 'welcome');
  // 100 - 6 upkeep + 3 dividend = 97
  ok(wa3.tokenPending === 97, 'pending reflects burn + dividend (100-6+3)', wa3.tokenPending);

  const stats = await getStats(port);
  ok(stats.colonyQuota === 6, 'quota gained exactly the upkeep burn', stats.colonyQuota);
  ok(stats.treasury && stats.treasury.STRATUM === 997, 'vault paid out exactly 3', stats.treasury);
  ok(stats.economy && stats.economy.upkeep && stats.economy.upkeep.burnedWeek === 6 &&
    stats.economy.upkeep.dividendsWeek === 3, 'upkeep block on /api/stats', stats.economy.upkeep);
  ok(mustLive(), 'the server never exited during the whole suite');

  a2.close(); a3.close();
  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1); });
