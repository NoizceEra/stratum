'use strict';
/**
 * test-leaderboard.js — /api/leaderboard, wired end to end.
 *
 * Proves: a player who claims N tiles and kills M monsters shows up in the land and
 * kills lists with the right counts, and the response never leaks a raw player key
 * (only a display name and the non-reversible keyTag hash) — real server, real
 * WebSocket client, a plain http.get against the endpoint. No mocks.
 *
 *   node test-leaderboard.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-leaderboard.db');
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
    env: { ...process.env, PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '0.02' },
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
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
    }).on('error', reject);
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
  console.log('\nSTRATUM leaderboard — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY = 'lb-test-key-0001';
  const a = new Client('A', port);
  await a.connect();

  section('SETUP — join, note the spawn point');
  a.send({ t: 'hello', key: KEY, name: 'RANKER' });
  const w = await a.waitFor(m => m.t === 'welcome');
  const sp = w.spawn;
  const myTag = T.keyTag(KEY);

  section('EMPTY — /api/leaderboard responds before anyone has done anything of note');
  const empty = await getJson(port, '/api/leaderboard');
  ok(empty.status === 200, 'endpoint answers 200', empty.status);
  ok(Array.isArray(empty.body.land) && Array.isArray(empty.body.kills) && Array.isArray(empty.body.level),
    'shape is {land, kills, level} arrays', empty.body);

  section('LAND — claim 3 tiles, they show up with the right count');
  const claimed = [];
  for (let i = 0; i < 3; i++) {
    const x = sp.x + 2 + i, y = sp.y + 2;
    a.send({ t: 'set', x, y, m: 1 });
    const r = await a.waitNew(m => (m.t === 'you' || m.t === 'deny') && m.x === x && m.y === y, 4000);
    if (r.t === 'you') claimed.push([x, y]);
  }
  ok(claimed.length === 3, 'placed 3 tiles over the wire', claimed.length);
  await sleep(200);
  const afterLand = await getJson(port, '/api/leaderboard');
  const myLand = afterLand.body.land.find(r => r.tag === myTag);
  ok(!!myLand, 'the claiming player appears in the land ranking', afterLand.body.land);
  ok(myLand && myLand.count === claimed.length, 'land count matches tiles actually claimed', myLand);
  ok(myLand && myLand.name === 'RANKER', 'land row carries the display name', myLand);

  section('KILLS — strike a monster to death, it shows up in kills + level');
  // hunt near spawn until something is close enough to attack
  let monId = null, mHp = null;
  for (let i = 0; i < 60 && !monId; i++) {
    a.send({ t: 'view', x: Math.round(a.pos() ? a.pos().x : sp.x), y: Math.round(a.pos() ? a.pos().y : sp.y) });
    const mm = a.msgs.filter(m => m.t === 'mons' && m.list && m.list.length).pop();
    if (mm) { monId = mm.list[0][0]; mHp = mm.list[0][4]; }
    if (!monId) await sleep(300);
  }
  ok(!!monId, 'the world showed us a monster to fight', monId);
  if (monId) {
    let killed = false, swings = 0;
    while (!killed && swings < 400) {
      a.send({ t: 'attack', id: monId });
      let r;
      try { r = await a.waitNew(m => m.t === 'combat' && m.id === monId, 2500); }
      catch (e) { break; }
      swings++;
      if (r.killed) killed = true;
      else if (r.err === 'no such creature' || r.err === 'out of range') {
        // walk toward the nearest visible monster and retry
        const mm = a.msgs.filter(m => m.t === 'mons' && m.list && m.list.length).pop();
        if (mm) { const row = mm.list.find(l => l[0] === monId) || mm.list[0]; monId = row[0]; await a.approach(row[2], row[3], 2, 8000); }
      }
      await sleep(60);
    }
    ok(killed, 'a monster was killed over the wire', { swings });
  }
  await sleep(200);
  const afterKill = await getJson(port, '/api/leaderboard');
  const myKills = afterKill.body.kills.find(r => r.tag === myTag);
  ok(!!myKills, 'the killer appears in the kills ranking', afterKill.body.kills);
  ok(myKills && myKills.kills >= 1, 'kills count reflects the kill', myKills);
  const myLevel = afterKill.body.level.find(r => r.tag === myTag);
  ok(!!myLevel, 'the killer appears in the level ranking too (same hunter record)', afterKill.body.level);

  section('NO RAW KEYS — the wire never carries the bearer token');
  const wholeBody = JSON.stringify(afterKill.body);
  ok(wholeBody.indexOf(KEY) === -1, 'the raw player key never appears anywhere in the response', KEY);
  ok(afterKill.body.land.every(r => typeof r.tag === 'string' && r.tag.length <= 12 && !('key' in r)),
    'land rows carry only name + tag, never a key field', afterKill.body.land);
  ok(afterKill.body.kills.every(r => typeof r.tag === 'string' && !('key' in r)),
    'kills rows carry only name + tag, never a key field', afterKill.body.kills);

  section('BOUNDED — never the whole world, never the raw tiles map');
  ok(afterKill.body.land.length <= 20, 'land list is capped (top-N, not the world)', afterKill.body.land.length);
  ok(afterKill.body.kills.length <= 20, 'kills list is capped', afterKill.body.kills.length);
  ok(afterKill.body.level.length <= 20, 'level list is capped', afterKill.body.level.length);

  a.close();

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
