'use strict';
/**
 * test-yield-bonus-integration.js — the 2026-09-21 reward-yield round (src/holder-bonus.js,
 * src/mining-streak.js, src/colony-milestone.js), wired end to end against a real server.
 *
 * Each module's own pure-math test file (test-holder-bonus.js, test-mining-streak.js,
 * test-colony-milestone.js) proves the tier tables and multiplier math in isolation. This
 * file proves the SERVER actually surfaces them correctly: a fresh player's welcome payload
 * carries sane base-tier defaults for all three, /api/stats exposes the same community-wide
 * colonyMilestone info publicly, a real harvest's response carries a real mining streak
 * count, and repeated harvesting actually builds the streak (and therefore the reward)
 * across genuine, real, server-processed actions — never mocked. Real server, real
 * WebSocket client, no mocks. Spawns its own server on an ephemeral port with its own DB —
 * never 8090, never the live DB.
 *
 *   node test-yield-bonus-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-yield-bonus-integration.db');
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
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1' }),
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
      let body = ''; r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
  console.log('\nSTRATUM yield-bonus integration — holder + streak + colony milestone — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const spawn0 = T.spawnPoint(0);

  // --------------------------------------------------------------------------
  section('WELCOME — a fresh player carries sane base-tier defaults for all three bonuses');
  // --------------------------------------------------------------------------
  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: 'yield-key-AAAA-0001', name: 'YIELDTESTER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.holderBalance === 0, 'a fresh player has 0 on-chain holder balance', wa.holderBalance);
  ok(wa.holderMultiplier === 1.0, 'a fresh player has the base 1.0x holder multiplier', wa.holderMultiplier);
  ok(wa.holderTier === 'Colonist', 'a fresh player starts at the base "Colonist" holder tier', wa.holderTier);
  ok(wa.miningStreak === 0, 'a fresh player has no mining streak yet', wa.miningStreak);
  ok(typeof wa.colonyMilestone === 'string' && wa.colonyMilestone.length > 0, 'welcome carries a real colony milestone name', wa.colonyMilestone);
  ok(typeof wa.colonyMultiplier === 'number' && wa.colonyMultiplier >= 1.0, 'welcome carries a real, >=1.0 colony multiplier', wa.colonyMultiplier);
  // Nothing has been burned yet on a fresh DB, so the colony must still be at its base tier.
  ok(wa.colonyMilestone === 'Outpost' && wa.colonyMultiplier === 1.0, 'a fresh world starts at the base "Outpost" colony tier', wa);

  // --------------------------------------------------------------------------
  section('/api/stats — the same colony milestone info is public, matching the wire');
  // --------------------------------------------------------------------------
  const stats0 = await getStats(port);
  ok(stats0.colonyMilestone && stats0.colonyMilestone.name === wa.colonyMilestone,
    '/api/stats.colonyMilestone.name matches what the player was told', stats0.colonyMilestone);
  ok(stats0.colonyMilestone && stats0.colonyMilestone.multiplier === wa.colonyMultiplier,
    '/api/stats.colonyMilestone.multiplier matches what the player was told', stats0.colonyMilestone);
  ok(stats0.colonyMilestone && stats0.colonyMilestone.next && stats0.colonyMilestone.next.name === 'Settlement',
    '/api/stats.colonyMilestone.next correctly points at the next real tier', stats0.colonyMilestone);

  // --------------------------------------------------------------------------
  section('MINING STREAK — a real harvest reports a real, nonzero streak; repeated steady mining grows it');
  // --------------------------------------------------------------------------
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
  const nodes = findNodesNear(spawn0, 30, 20);
  ok(nodes.length >= 10, 'found enough real nodes near spawn to harvest repeatedly', nodes.length);

  // Harvest a sequence of DIFFERENT nearby nodes, spaced comfortably inside
  // src/mining-streak.js's sweet spot (900ms..18000ms), collecting only the genuine,
  // non-partial yields (a node can take a couple of hits before it fully depletes and
  // actually pays out — a partial hit correctly does not touch the streak at all).
  const streaks = [];
  for (let i = 0; i < nodes.length && streaks.length < 4; i++) {
    a.send({ t: 'move', x: nodes[i].x, y: nodes[i].y });
    await sleep(60);
    a.send({ t: 'harvest', x: nodes[i].x, y: nodes[i].y });
    let res;
    try { res = await a.waitNew(m => m.t === 'harvested' && m.x === nodes[i].x && m.y === nodes[i].y, 3000); }
    catch (e) { continue; }
    if (!res.err && !res.partial && typeof res.streak === 'number') streaks.push(res.streak);
    await sleep(1400); // comfortably inside MIN_GAP_MS..MAX_GAP_MS
  }
  ok(streaks.length >= 2, 'collected at least two real, non-partial harvest yields to compare', streaks);
  ok(streaks[0] >= 1, 'the first genuine harvest already reports a streak of at least 1', streaks[0]);
  let monotonic = true;
  for (let i = 1; i < streaks.length; i++) if (streaks[i] < streaks[i - 1]) monotonic = false;
  ok(monotonic, 'the streak count never decreases across steadily-paced harvests', streaks);
  ok(streaks[streaks.length - 1] > streaks[0] || streaks.length < 2,
    'steady mining actually grows the streak beyond its starting value', streaks);

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
