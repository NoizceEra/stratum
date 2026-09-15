'use strict';
/**
 * test-achievements-integration.js — achievements.js, wired end to end.
 *
 * test-achievements.js proves the MODULE is pure and correct. This file proves the
 * SERVER actually uses it: a fresh player's first kill unlocks "First Blood" and is
 * told about it over the wire, and a returning player (same key, new connection) sees
 * it reported as already-unlocked without the unlock event firing a second time.
 * Spawns its own server on an ephemeral port with its own DB (data/test-achievements.db)
 * — never 8090, never the live DB.
 *
 *   node test-achievements-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-achievements.db');
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
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; this.nodes = []; }
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
  countOf(test) { return this.msgs.filter(test).length; }
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
  console.log('\nSTRATUM achievements integration — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const key = 'ach-integ-key-0001';
  const a = new Client('A', port);
  await a.connect();

  section('WELCOME — a fresh player carries no unlocks yet');
  a.send({ t: 'hello', key, name: 'HUNTER' });
  await a.waitFor(m => m.t === 'welcome');
  const initAch = await a.waitFor(m => m.t === 'achievements');
  ok(Array.isArray(initAch.unlocked) && initAch.unlocked.length === 0, 'fresh arrival ships an empty unlocked list', initAch.unlocked);
  ok(initAch.title === null, 'fresh arrival has no current title', initAch.title);

  section('FIRST BLOOD — the first kill unlocks it and tells the client');
  const near = await a.waitFor(m => m.t === 'mons' && m.list && m.list.length);
  const mon = near.list[0];
  const dTo = await a.approach(mon[2], mon[3], 3, 20000);
  ok(dTo <= 4, 'walked into strike range of a creature', dTo);
  let killed = null;
  for (let i = 0; i < 30 && !killed; i++) {
    a.send({ t: 'attack', id: mon[0] });
    const r = await a.waitNew(m => m.t === 'combat' && m.id === mon[0], 4000).catch(() => null);
    if (r && r.killed) killed = r;
    else if (r && r.err) break;
    await sleep(350);
  }
  ok(!!killed, 'the creature was slain', killed);
  // the unlock rides the same synchronous handler as the kill, so it may already be
  // sitting in the buffer by the time we look — waitFor (not waitNew) covers both.
  const unlock = await a.waitFor(m => m.t === 'achievement' && m.id === 'first-blood', 4000).catch(() => null);
  ok(!!unlock, 'server sent an "achievement" message for first-blood', unlock);
  ok(unlock && unlock.name === 'First Blood' && unlock.desc && !unlock.title,
    'unlock message carries the right id/name and no title (first-blood grants none)', unlock);

  section('RECONNECT — same key reports it already-unlocked, no re-trigger');
  a.close();
  await sleep(300);
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key, name: 'HUNTER' });
  await b.waitFor(m => m.t === 'welcome');
  const backAch = await b.waitFor(m => m.t === 'achievements');
  ok(Array.isArray(backAch.unlocked) && backAch.unlocked.includes('first-blood'),
    'reconnect reports first-blood as already-unlocked', backAch.unlocked);
  await sleep(600);       // give checkAchievements() on hello a moment to (not) refire
  ok(b.countOf(m => m.t === 'achievement' && m.id === 'first-blood') === 0,
    'no duplicate "achievement" unlock event was sent on reconnect', b.msgs.filter(m => m.t === 'achievement'));
  b.close();

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
