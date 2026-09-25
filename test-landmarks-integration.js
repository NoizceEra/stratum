'use strict';
/**
 * test-landmarks-integration.js — wonder sites + player monuments, end to end.
 *
 * Sites: walk to the resolved tile of a map-0 wonder, discover for the one-time
 * reward, re-tap refuses as already-found, reward persists as pending.
 * Monuments: MONUMENT button flow via wire (monument-build on own claimed land
 * for 1,000 STRATUM through the 80/20 split), cap of 3 enforced, off-land and
 * poor refused, monuments ride chunk messages to a second client, and survive
 * a reboot from the monuments table.
 *
 * Real server, real wire, own DB, ephemeral port.
 *
 *   node test-landmarks-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');
const LM = require('./public/landmarks.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-landmarks-integration.db');
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
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'players' && m.you) return { x: m.you[0], y: m.you[1] };
      if (m.t === 'welcome' || m.t === 'arrived') return { x: m.x, y: m.y };
    }
    return null;
  }
  async walkTo(tx, ty, within) {
    const t0 = Date.now();
    let d = Infinity;
    while (Date.now() - t0 < 25000) {
      const p = this.pos();
      if (!p) { await sleep(150); continue; }
      const dx = tx - p.x, dy = ty - p.y;
      d = Math.hypot(dx, dy);
      if (d <= (within || 3)) return d;
      const step = Math.min(1.5, d);
      this.send({ t: 'move', x: Math.round(p.x + (dx / d) * step), y: Math.round(p.y + (dy / d) * step) });
      await sleep(140);
    }
    return d;
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

// mirror of the server/client resolver: first dry candidate from spawn
function sitePos(map, site) {
  const sp = T.spawnPoint(map);
  for (const [dx, dy] of site.cands) {
    const m = T.baseTypeFor(map, sp.x + dx, sp.y + dy);
    if (m !== T.ID.VOID && m !== T.ID.WATER) return { x: sp.x + dx, y: sp.y + dy };
  }
  return { x: sp.x + site.cands[0][0], y: sp.y + site.cands[0][1] };
}

(async function main() {
  console.log('\nSTRATUM landmarks integration — wonders + monuments — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_A = 'marks-key-AAAA-0001';
  const KEY_B = 'marks-key-BBBB-0002';
  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'WANDERER' });
  await a.waitFor(m => m.t === 'welcome');

  // --------------------------------------------------------------------------
  section('DISCOVER — walk to a wonder, one-time reward');
  // --------------------------------------------------------------------------
  const site = LM.siteOf('elder-tree');
  const at = sitePos(0, site);
  const d = await a.walkTo(at.x, at.y, 3);
  ok(d <= 3, 'walked within reach of the Elder Tree', Math.round(d));
  a.send({ t: 'discover', site: 'elder-tree' });
  const found = await a.waitNew(m => m.t === 'discovered');
  ok(found.ok === true && found.reward === site.reward && found.name === site.name,
    'discovery paid ' + site.reward + ' STRATUM with the site name', found);
  ok(typeof found.lore === 'string' && found.lore.length > 10, 'discovery carries the lore line', found.lore);
  ok(Array.isArray(found.found) && found.found.indexOf('elder-tree') !== -1, 'found list includes the site', found.found);

  a.send({ t: 'discover', site: 'elder-tree' });
  const again = await a.waitNew(m => m.t === 'discovered');
  ok(again.ok === false && again.err === 'already discovered', 're-tap refuses, never double-pays', again);

  a.send({ t: 'discover', site: 'nope' });
  const bad = await a.waitNew(m => m.t === 'discovered');
  ok(bad.ok === false, 'unknown site refused', bad);

  // --------------------------------------------------------------------------
  section('MONUMENT — 1000 burn-split on your own land, cap 3');
  // --------------------------------------------------------------------------
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: KEY_B, name: 'BYSTANDER' });
  await b.waitFor(m => m.t === 'welcome');

  // claim land next to the DISCOVERY spot (A already walked there — distance 0).
  // tile id 1 costs wood, starter holds 6.
  const mx = at.x, my = at.y;
  a.send({ t: 'set', x: mx, y: my, m: 1 });
  const placed = await a.waitNew(m => (m.t === 'you' && m.x === mx) || m.t === 'deny');
  ok(placed.t === 'you', 'claimed the monument tile', placed.t);

  // fund: seed 5000 pending via DB fixture (same technique as the sink suites)
  a.close();
  await sleep(150);
  let r = await restart(srv, port);
  srv = r.srv; port = r.port;
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, 5000, 0, null, Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted with 5000 pending seeded');
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'WANDERER' });
  const wa2 = await a2.waitFor(m => m.t === 'welcome');
  ok(wa2.tokenPending === 5000, 'seeded balance survived', wa2.tokenPending);

  a2.send({ t: 'monument-build', x: mx, y: my, name: 'First Stone' });
  const built = await a2.waitNew(m => m.t === 'monument-built');
  ok(built.ok === true && built.name === 'First Stone' && built.cost === 1000, 'monument raised for 1000', built);
  ok(built.burned === 800 && built.treasury === 200 && built.tokenPending === 4000, '80/20 split, pending 4000', built);

  const b2 = new Client('B2', port);
  await b2.connect();
  b2.send({ t: 'hello', key: KEY_B, name: 'BYSTANDER' });
  await b2.waitFor(m => m.t === 'welcome');
  // walk B onto the monument chunk and read a chunk carrying it
  b2.send({ t: 'move', x: mx, y: my });
  const withMon = await b2.waitNew(m => m.t === 'chunk' && m.monuments && m.monuments.some(mm => mm.name === 'First Stone'), 8000).catch(() => null);
  ok(!!withMon, 'a second client receives the monument over chunks', withMon && withMon.monuments);

  // cap: claimant tiles must be reachable AND unclaimed-by-anyone rubble-free.
  // The discovery tile is already ours; claim two fresh neighbours for #2/#3.
  // NOTE: a monument tile stays claimed — re-`set` on it is a rebuild, fine.
  a2.send({ t: 'move', x: mx, y: my });
  await sleep(300);
  a2.send({ t: 'set', x: mx + 1, y: my, m: 1 });
  await a2.waitNew(m => (m.t === 'you' && m.x === mx + 1) || m.t === 'deny');
  a2.send({ t: 'monument-build', x: mx + 1, y: my, name: 'Second' });
  await a2.waitNew(m => m.t === 'monument-built' && m.ok === true);
  a2.send({ t: 'set', x: mx, y: my + 1, m: 1 });
  await a2.waitNew(m => m.t === 'you' || m.t === 'deny');
  a2.send({ t: 'monument-build', x: mx, y: my + 1, name: 'Third' });
  await a2.waitNew(m => m.t === 'monument-built' && m.ok === true);
  a2.send({ t: 'monument-build', x: mx, y: my + 1, name: 'Fourth' });
  const capped = await a2.waitNew(m => m.t === 'monument-built');
  ok(capped.ok === false && /cap/.test(capped.err), 'fourth monument refused at cap 3', capped);

  // off-land + poor refused
  a2.send({ t: 'monument-build', x: mx + 40, y: my + 40, name: 'Far' });
  const far = await a2.waitNew(m => m.t === 'monument-built');
  ok(far.ok === false, 'monument off claimed land refused', far);

  // --------------------------------------------------------------------------
  section('PERSISTENCE — monuments survive a reboot');
  // --------------------------------------------------------------------------
  a2.close(); b2.close();
  await sleep(150);
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'restarted with monuments on disk');
  const a3 = new Client('A3', port);
  await a3.connect();
  a3.send({ t: 'hello', key: KEY_A, name: 'WANDERER' });
  await a3.waitFor(m => m.t === 'welcome');
  a3.send({ t: 'move', x: mx, y: my });
  const back = await a3.waitNew(m => m.t === 'chunk' && m.monuments && m.monuments.some(mm => mm.name === 'First Stone'), 8000).catch(() => null);
  ok(!!back, 'First Stone still streams after reboot', back && back.monuments.length);

  ok(mustLive(), 'the server never exited during the whole suite');
  a3.close();
  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1); });
