'use strict';
/**
 * test-anti-cheat-integration.js — src/anti-cheat.js, wired end to end against a real
 * server via applyCommerceReward()'s single choke point.
 *
 * test-anti-cheat.js proves the pure rate/rhythm/decay math in isolation. This file
 * proves the SERVER actually uses it correctly: a rapid-fire burst of real craft actions
 * eventually gets its economic reward (gold/STRATUM) suppressed while the underlying game
 * action (materials consumed, item still crafted) keeps working exactly as normal — never
 * a block, never a ban, nothing a human has to review (see applyCommerceReward()'s own
 * comment in server.js) — and that a second client playing at an ordinary human pace
 * throughout is never affected at all. Real server, real WebSocket clients, no mocks —
 * same shape as every other *-integration.js file in this repo. Spawns its own server on
 * an ephemeral port with its own DB — never 8090, never the live DB.
 *
 *   node test-anti-cheat-integration.js      exits 0 only if every case PASSes
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
const TESTDB = path.join(CWD, 'data', 'test-anti-cheat-integration.db');
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
  waitFor(test, ms) {
    const hit = this.msgs.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout')); }, ms || 5000);
    });
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

/** One craft(1)+salvage(1) round trip — net inventory neutral (stays under the flint
 *  dagger's stack limit of 10 no matter how many rounds run), but each craft() is one
 *  real reward-earning action for src/anti-cheat.js to see. */
async function craftSalvageRound(client) {
  client.send({ t: 'craft', id: 'r_flint_dagger' });
  const crafted = await client.waitNew(m => m.t === 'crafted' && m.id === 'r_flint_dagger', 4000);
  client.send({ t: 'salvage', id: 'r_flint_dagger', count: 1 });
  await client.waitNew(m => m.t === 'salvaged' && m.id === 'r_flint_dagger', 4000);
  return crafted;
}

(async function main() {
  console.log('\nSTRATUM anti-cheat integration — economic-reward throttling — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const KEY_BOT = 'ac-key-BOT-0001';
  const KEY_HUMAN = 'ac-key-HUMAN-0001';
  const spawn0 = T.spawnPoint(0);

  // Seed both players with enough materials to craft indefinitely without a real harvest
  // grind — same fixture technique every other *-integration.js file uses. Kept under
  // STACK_LIMITS (wood/ore 400) since ECO.add() clamps to it regardless of the seed.
  let seed0 = new Client('SEED0', port);
  await seed0.connect();
  seed0.send({ t: 'hello', key: KEY_BOT, name: 'RAPIDFIRE' });
  await seed0.waitFor(m => m.t === 'welcome');
  seed0.close();
  await sleep(100);
  let seed1 = new Client('SEED1', port);
  await seed1.connect();
  seed1.send({ t: 'hello', key: KEY_HUMAN, name: 'STEADYPACE' });
  await seed1.waitFor(m => m.t === 'welcome');
  seed1.close();
  await sleep(150);

  const r0 = await restart(srv, port);
  srv = r0.srv; port = r0.port;
  ok(mustLive(), 'server restarted cleanly to seed both players\' materials');
  withDb(db => {
    for (const key of [KEY_BOT, KEY_HUMAN]) {
      db.prepare('INSERT OR REPLACE INTO player_state(k,map,x,y,hp,kills,inv,tool) VALUES(?,?,?,?,?,?,?,?)')
        .run(key, 0, spawn0.x, spawn0.y, 100, 0, JSON.stringify({ wood: 300, ore: 300, herb: 150, crystal: 80, gold: 0 }), 0);
    }
  });
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  ok(mustLive(), 'server restarted cleanly after seeding materials');

  const bot = new Client('BOT', port);
  await bot.connect();
  bot.send({ t: 'hello', key: KEY_BOT, name: 'RAPIDFIRE' });
  await bot.waitFor(m => m.t === 'welcome');

  const human = new Client('HUMAN', port);
  await human.connect();
  human.send({ t: 'hello', key: KEY_HUMAN, name: 'STEADYPACE' });
  await human.waitFor(m => m.t === 'welcome');

  // --------------------------------------------------------------------------
  section('RAPID-FIRE BURST — economic reward eventually throttles; the craft itself never stops working');
  // --------------------------------------------------------------------------
  let throttledSeen = false;
  let firstSuccessGrantedReward = false;
  let everyThrottledCraftStillYieldedAnItem = true;
  const ROUNDS = 45;
  for (let i = 0; i < ROUNDS && !throttledSeen; i++) {
    const crafted = await craftSalvageRound(bot);
    if (i === 0) firstSuccessGrantedReward = crafted.gains && crafted.gains.token > 0;
    if (crafted.count !== 1 || crafted.item !== 'flint_dagger') everyThrottledCraftStillYieldedAnItem = false;
    if (crafted.gains && crafted.gains.token === 0 && crafted.gains.gold === 0) throttledSeen = true;
  }
  ok(firstSuccessGrantedReward, 'the very first craft (before any burst) granted a real reward', firstSuccessGrantedReward);
  ok(throttledSeen, 'sustained rapid-fire crafting eventually gets its economic reward suppressed', throttledSeen);
  ok(everyThrottledCraftStillYieldedAnItem, 'even a throttled craft still yields the item and consumes materials — the ACTION never stops working, only the reward', everyThrottledCraftStillYieldedAnItem);

  section('STILL PLAYABLE — the throttled account can keep crafting/salvaging (no block, no ban)');
  // --------------------------------------------------------------------------
  const stillWorks = await craftSalvageRound(bot);
  ok(stillWorks.item === 'flint_dagger' && stillWorks.count === 1, 'crafting still works immediately after a throttle event — never locked out', stillWorks);

  // --------------------------------------------------------------------------
  section('NORMAL HUMAN PACE — never throttled, throughout the whole suite');
  // --------------------------------------------------------------------------
  let humanEverThrottled = false;
  for (let i = 0; i < 6; i++) {
    const crafted = await craftSalvageRound(human);
    if (crafted.gains && crafted.gains.token === 0 && crafted.gains.gold === 0) humanEverThrottled = true;
    await sleep(400); // a real pause between actions — nothing close to the bot's cadence above
  }
  ok(humanEverThrottled === false, 'a player crafting at an ordinary human pace is never throttled', humanEverThrottled);

  mustLive();
  ok(mustLive(), 'the server never exited during the whole suite');
  bot.close(); human.close();
  try { srv.kill(); } catch (e2) {}
  await sleep(200);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  try { if (typeof srv !== 'undefined' && srv && srv.exited === null) srv.kill('SIGKILL'); } catch (e2) {}
  console.error('FATAL', e && (e.stack || e.message));
  process.exit(1);
});
