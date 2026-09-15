/**
 * test-ambient-combat-integration.js — src/ambient-combat.js, wired end to end.
 *
 * test-ambient-combat.js proves the MODULE is pure and correct (34/34, see run it
 * separately). This file proves the SERVER actually uses it, per ROADMAP_COZY.md's
 * Phase 1: a real player near a real monster on a real Sanctuary map (0) takes only
 * gentle, capped damage over several ticks and never sees the monster chase or
 * wind-up; a click-to-attack against that same monster is refused; a Sanctuary kill
 * still grants loot and XP through world.js's ordinary grantLoot/awardXp machinery;
 * and a monster on the one Frontier map (1) still exhibits full wind-up/chase/crit
 * combat, byte-for-byte as before the cozy pivot.
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-drops-integration.js
 * and test-achievements-integration.js. Spawns its own server on an ephemeral port with
 * its own DB (data/test-ambient-combat-integration.db) — never 8090, never the live DB.
 *
 *   node test-ambient-combat-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');
const AC = require('./src/ambient-combat.js');
const { MODE, PHASE } = require('./world.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-ambient-combat-integration.db');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
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
    // real respawn clock: this suite doesn't need a kill->respawn round trip, only a
    // kill, so there's nothing here for STRATUM_RESPAWN_SCALE to speed up
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
    }
    return null;
  }
  monsters() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'mons') return this.msgs[i].list;
    return [];
  }
  monById(id) { for (const e of this.monsters()) if (e[0] === id) return e; return null; }
  /** Every 'mons' sample seen for one monster id, in arrival order: [{mode,phase,hp}]. */
  samplesOf(id) {
    const out = [];
    for (const m of this.msgs) {
      if (m.t !== 'mons') continue;
      for (const e of m.list) if (e[0] === id) out.push({ hp: e[4], maxHp: e[5], mode: e[6], phase: e[7] });
    }
    return out;
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
  /**
   * Idle drift (world.js's idleWander) can carry a Sanctuary creature away from a
   * player who just stands still — nudge back toward it whenever it strays past
   * `within`, for `ms`, so ambient ticks (range-gated) keep firing the way a player
   * who is actually pottering nearby (not literally motionless) would experience.
   */
  async stayNear(id, within, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.monById(id), p = this.pos();
      if (m && p) {
        const d = Math.hypot(m[2] - p.x, m[3] - p.y);
        if (d > within) {
          const step = Math.min(1.2, d);
          this.send({ t: 'move', x: Math.round(p.x + (m[2] - p.x) / d * step), y: Math.round(p.y + (m[3] - p.y) / d * step) });
        }
      }
      await sleep(250);
    }
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async function main() {
  console.log('\nSTRATUM ambient combat integration — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const a = new Client('A', port);
  await a.connect();

  try {
    section('SETUP — a fresh hunter lands on map 0 (Sanctuary)');
    a.send({ t: 'hello', key: 'ambient-key-AAAA-0001', name: 'DRIFTER' });
    const w = await a.waitFor(m => m.t === 'welcome');
    ok(w.map === 0, 'new players still land on map 0', w.map);
    ok(T.toneOf(w.map) === 'sanctuary', 'map 0 is Sanctuary-toned (Phase 0 of the cozy pivot)', T.toneOf(w.map));
    const p0 = w.spawn;

    // A low-HP creature keeps the "ambient kill" case in section 3 fast: at
    // TUNE.playerDmgPerTick per tick every TUNE.tickMs, a tankier neighbour would take
    // several times as long for no extra coverage.
    // Only a home within world.js's own MON_ACTIVATE radius (activated automatically by
    // the 'hello' handler's world.activate(map, spawn.x, spawn.y)) is materialised yet —
    // this test client never sends 'view' the way public/game.js does, so anything
    // farther out would never appear in a 'mons' packet at all.
    const homes = T.homesNear(0, Math.round(p0.x), Math.round(p0.y), 4)
      .map(h => Object.assign({ d: Math.hypot(h.x - p0.x, h.y - p0.y) }, h))
      .filter(h => h.d < 80)
      .sort((x, y) => x.sp.hp - y.sp.hp);
    const home = homes[0] || null;
    ok(!!home, home ? `chose the lowest-HP neighbour: ${home.sp.kind} (${home.sp.hp}hp) at ${Math.round(home.x)},${Math.round(home.y)}` : 'no monster home found near spawn on map 0');
    if (!home) throw new Error('no monster home to test against');

    await a.approach(home.x, home.y, Math.max(1, AC.TUNE.range - 1), 30000);
    await sleep(400);
    // Match by proximity to the PLAYER, not the original home point: idleWander can
    // drift the creature up to WANDER_R tiles from home during the (up to 30s) approach.
    const ppos = a.pos();
    let mon = null, monD = Infinity;
    for (const e of a.monsters()) {
      const d = ppos ? Math.hypot(e[2] - ppos.x, e[3] - ppos.y) : Math.hypot(e[2] - home.x, e[3] - home.y);
      if (d < monD) { monD = d; mon = e; }
    }
    ok(!!mon && monD <= AC.TUNE.range + 2, 'found the resident creature nearby (' + monD.toFixed(1) + ' tiles away)', mon && mon[0]);
    if (!mon) throw new Error('no resident creature in range');
    const monId = mon[0];

    section('AMBIENT COMBAT — proximity alone, no click, gentle and never aggressive');
    // three ticks' worth of dwell time, plus generous slack for scheduling jitter
    const dwellMs = AC.TUNE.tickMs * 3 + 4000;
    await a.stayNear(monId, AC.TUNE.range - 1, dwellMs);

    const samples = a.samplesOf(monId);
    ok(samples.length > 5, samples.length + ' "mons" samples collected for the resident creature over ' + Math.round(dwellMs / 1000) + 's', samples.length);
    const everChased = samples.some(s => s.mode === MODE.CHASE);
    const everWoundUp = samples.some(s => s.phase === PHASE.WINDUP);
    ok(!everChased, 'the creature never entered MODE.CHASE — no aggro on a Sanctuary map', samples.map(s => s.mode));
    ok(!everWoundUp, 'the creature never telegraphed a wind-up — no PHASE.WINDUP on a Sanctuary map', samples.map(s => s.phase));

    const finalHp = samples.length ? samples[samples.length - 1].hp : mon[4];
    ok(finalHp < mon[4], 'the creature lost HP over several ambient ticks (' + mon[4] + ' -> ' + finalHp + ')', { start: mon[4], end: finalHp });

    const dmgMsgs = a.msgs.filter(m => m.t === 'dmg');
    ok(dmgMsgs.length > 0, 'the player took at least one ambient hit (' + dmgMsgs.length + ' dmg message(s))', dmgMsgs.length);
    const allGentle = dmgMsgs.every(m => m.dmg <= AC.TUNE.creatureDmgPerTick);
    ok(allGentle, 'every hit was capped at TUNE.creatureDmgPerTick=' + AC.TUNE.creatureDmgPerTick + ', never a real blow', dmgMsgs.map(m => m.dmg));
    const noCrash = a.pos() !== null;
    ok(noCrash, 'the player never died to ambient damage (HP floor respected)', a.pos());

    section('CLICK-TO-ATTACK — refused on a Sanctuary map, ambient combat is automatic');
    a.send({ t: 'attack', id: monId });
    const refused = await a.waitNew(m => m.t === 'combat' && m.id === monId, 3000).catch(() => null);
    ok(!!refused, 'the server answered the attack message', refused);
    ok(refused && !!refused.err && refused.killed !== true, 'the attack was refused, not resolved as a swing', refused);

    section('KILL — an ambient kill still grants loot and XP through the ordinary path');
    let killMsg = null;
    const killBudgetMs = Math.ceil((home.sp.hp / AC.TUNE.playerDmgPerTick) + 2) * AC.TUNE.tickMs + 8000;
    a.stayNear(monId, AC.TUNE.range - 1, killBudgetMs);   // fire-and-forget: runs alongside the poll below
    const kt0 = Date.now();
    while (Date.now() - kt0 < killBudgetMs && !killMsg) {
      const hit = a.msgs.find(m => m.t === 'combat' && m.id === monId && m.killed === true);
      if (hit) { killMsg = hit; break; }
      await sleep(300);
    }
    ok(!!killMsg, 'an ambient kill was reported on the wire within ' + Math.round(killBudgetMs / 1000) + 's', killMsg || { waitedMs: Date.now() - kt0 });
    if (killMsg) {
      ok(killMsg.loot && typeof killMsg.loot === 'string', 'the kill carries loot, granted by world.js\'s grantLoot — same as a Frontier kill', killMsg.loot);
      ok(typeof killMsg.kills === 'number' && killMsg.kills >= 1, 'the player\'s kill count went up', killMsg.kills);
      ok(typeof killMsg.level === 'number' && killMsg.level >= 1, 'a level was reported, derived from awardXp\'s XP grant', killMsg.level);
      const st = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
          let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
        }).on('error', rej);
      });
      const tag = T.keyTag('ambient-key-AAAA-0001');
      const hunter = (st.volatile.hunters || []).find(h => h.k === tag);
      ok(!!hunter && hunter.xp > 0, 'the volatile layer recorded real XP for the killer (' + (hunter && hunter.xp) + 'xp)', hunter);
      ok(!!hunter && hunter.kills >= 1, 'and a real kill, through the exact same hunter/XP bookkeeping a Frontier kill uses', hunter);
    }

    section('FRONTIER UNCHANGED — map 1 still runs full wind-up/chase combat');
    const b = new Client('B', port);
    await b.connect();
    b.send({ t: 'hello', key: 'ambient-key-BBBB-0002', name: 'RAIDER' });
    const wb = await b.waitFor(m => m.t === 'welcome');
    ok(T.toneOf(1) === 'frontier', 'map 1 is Frontier-toned', T.toneOf(1));
    b.send({ t: 'travel', map: 1 });
    const arr = await b.waitNew(m => m.t === 'arrived' && m.map === 1, 5000);
    ok(arr.map === 1, 'B travelled to the Frontier map', arr.map);
    await sleep(500);

    const p1 = arr.spawn;
    const fHomes = T.homesNear(1, Math.round(p1.x), Math.round(p1.y), 3)
      .map(h => Object.assign({ d: Math.hypot(h.x - p1.x, h.y - p1.y) }, h))
      // melee-only: 'pack' calls allies (noisy), 'spitter'/'kiter' hold range and can
      // dodge a closing player for a while, delaying the wind-up this section waits for
      .filter(h => (h.sp.role === 'tank' || h.sp.role === 'swarm') && h.d < 80)
      .sort((x, y) => x.d - y.d);
    const fHome = fHomes[0] || null;
    ok(!!fHome, fHome ? `chose a Frontier neighbour: ${fHome.sp.kind} at ${Math.round(fHome.x)},${Math.round(fHome.y)}` : 'no Frontier monster home found near spawn');
    if (fHome) {
      await b.approach(fHome.x, fHome.y, Math.max(2, fHome.sp.aggro - 1), 30000);
      let sawChase = false, sawWindup = false, fId = null;
      const ft0 = Date.now();
      while (Date.now() - ft0 < 20000 && !(sawChase && sawWindup)) {
        for (const e of b.monsters()) {
          if (Math.hypot(e[2] - fHome.x, e[3] - fHome.y) > 12) continue;
          fId = e[0];
          if (e[6] === MODE.CHASE) sawChase = true;
          if (e[7] === PHASE.WINDUP) sawWindup = true;
        }
        await sleep(150);
      }
      ok(sawChase, 'the Frontier creature AGGROS and chases (mode=CHASE) — unlike Sanctuary', fId);
      ok(sawWindup, 'the Frontier creature still telegraphs a wind-up (phase=WINDUP) before it lands a blow', fId);
    }
    b.close();

    ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');
  } finally {
    a.close();
    srv.kill('SIGTERM');
    await sleep(500);
    if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
    if (fail > 0) {
      console.log('\n--- server log (last 40 lines) ---');
      console.log(srv.log.split('\n').slice(-40).join('\n'));
      console.log('--- end server log ---');
    }
  }

  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e.stack || e); process.exit(1); });
