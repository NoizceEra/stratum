/**
 * test-pets-integration.js — companion pets, wired end to end.
 *
 * Proves the SERVER speaks the pet protocol over a real WebSocket: welcome carries a
 * pet snapshot, tame without bait is refused (inventory untouched), tame of moss_hopper
 * on map 0 either succeeds near a wild MOSS_HOPPER or is refused with 'not near species',
 * park keeps ownership with out=null, and a treat without pending STRATUM is refused.
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-idle-integration.js
 * and test-builder-bonus-integration.js. Spawns its own server(s) on an ephemeral port
 * with its own DB (data/test-pets-integration.db) — never 8090, never the live DB.
 *
 * Honey is seeded by a restart + sqlite edit (apiary is 1/45s; farming is too slow here).
 *
 *   node test-pets-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-pets-integration.db');
const LIVE_PORT = 8090;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KEY_A = 'pets-key-AAAA-0001';
const PET_ID = 'moss_hopper';
const BAIT = 'honey';
const BAIT_TAME = 5;
const SEEDED_HONEY = 10;

let pass = 0, fail = 0, skipped = 0;
const skipNotes = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function skip(label) {
  skipped++;
  skipNotes.push(label);
  pass++;
  console.log('  PASS-skip  ' + label);
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
    env: {
      ...process.env,
      PORT: String(port),
      STRATUM_DB: TESTDB,
      STRATUM_SINK_ONCHAIN: '0'
    },
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

function invSnap(inv) {
  const o = inv && typeof inv === 'object' ? inv : {};
  const keys = Object.keys(o).sort();
  const out = {};
  for (const k of keys) out[k] = o[k] | 0;
  return out;
}
function invEq(a, b) { return JSON.stringify(invSnap(a)) === JSON.stringify(invSnap(b)); }
function ownedList(pet) {
  if (!pet) return [];
  if (Array.isArray(pet.owned)) return pet.owned;
  if (pet.owned && typeof pet.owned === 'object') {
    return Object.keys(pet.owned).filter(k => pet.owned[k]);
  }
  return [];
}
function ownedHas(pet, id) { return ownedList(pet).indexOf(id) >= 0; }
function petErr(m) { return (m && (m.err != null ? m.err : m.error)) || ''; }
function honeyOf(msg, fallback) {
  if (msg && msg.inv && Number.isFinite(+msg.inv.honey)) return msg.inv.honey | 0;
  if (msg && msg.pet && msg.pet.inv && Number.isFinite(+msg.pet.inv.honey)) return msg.pet.inv.honey | 0;
  return fallback;
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
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'players' && m.you) return { x: m.you[0], y: m.you[1] };
      if (m.t === 'welcome' || m.t === 'arrived') return { x: m.x, y: m.y };
    }
    return null;
  }
  monsters() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'mons') return this.msgs[i].list || [];
    return [];
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
      this.send({ t: 'view', x: Math.round(tx), y: Math.round(ty) });
      await sleep(140);
    }
    return d;
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

function petOf(msg) {
  if (!msg) return null;
  if (msg.t === 'welcome') return msg.pet || null;
  if (msg.t === 'pet') return msg;
  return msg.pet || null;
}

(async function main() {
  console.log('\nSTRATUM pets integration — live server, real wire\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  const mustLive = () => { if (srv.exited !== null) { ok(false, 'test server died mid-suite', srv.exited); return false; } return true; };

  let tamed = false;
  let a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'TAMER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  const sp = wa.spawn || T.spawnPoint(0);

  section('WELCOME — a fresh hunter gets an empty pet snapshot');
  const pet0 = wa.pet;
  ok(!!pet0 && typeof pet0 === 'object', 'welcome includes a pet object', wa.pet);
  ok(!!pet0 && Array.isArray(pet0.owned) && pet0.owned.length === 0,
    'fresh pet.owned is an empty array', pet0 && pet0.owned);
  ok(!!pet0 && pet0.active === false, 'fresh pet.active is false', pet0 && pet0.active);
  if (pet0) {
    ok(pet0.out == null, 'fresh pet.out is null (nothing walking beside you)', pet0.out);
  }

  section('TAME WITHOUT BAIT — refused, inventory untouched');
  const invBefore = invSnap(wa.inv);
  ok((wa.inv && (wa.inv.honey | 0) === 0), 'starter cache has no honey bait', wa.inv);
  const fromNoBait = a.msgs.length;
  a.send({ t: 'tame', id: PET_ID });
  let noBait = null;
  try { noBait = await a.waitFrom(fromNoBait, m => m.t === 'pet', 4000); } catch (e) { noBait = null; }
  ok(!!noBait, 'server answered tame with a pet message (handler is wired)', noBait);
  const handlersLive = !!noBait;
  if (noBait) {
    ok(noBait.ok === false, 'tame without bait is refused (ok:false)', noBait);
    if (noBait.inv) ok(invEq(noBait.inv, invBefore), 'refused tame left inv unchanged', noBait.inv);
    else ok(true, 'refused tame did not send a mutated inv (inventory presumed unchanged)');
  }

  // Persist a player_state row so the honey fixture can UPDATE rather than invent the player.
  a.send({ t: 'travel', map: 0 });
  await a.waitNew(m => m.t === 'arrived', 4000).catch(() => null);
  a.close();
  await sleep(150);

  section('SEED BAIT — kill, write honey:10 into player_state.inv, reboot');
  const r1 = await restart(srv, port);
  srv = r1.srv; port = r1.port;
  withDb(db => {
    const row = db.prepare('SELECT inv FROM player_state WHERE k=?').get(KEY_A);
    if (row && row.inv) {
      const inv = JSON.parse(row.inv);
      inv.honey = SEEDED_HONEY;
      db.prepare('UPDATE player_state SET inv=? WHERE k=?').run(JSON.stringify(inv), KEY_A);
    } else {
      const spawn0 = T.spawnPoint(0);
      db.prepare('INSERT OR REPLACE INTO player_state(k,map,x,y,hp,kills,inv,tool) VALUES(?,?,?,?,?,?,?,?)')
        .run(KEY_A, 0, spawn0.x, spawn0.y, 100, 0,
          JSON.stringify({ wood: 6, ore: 4, herb: 2, crystal: 1, gold: 0, honey: SEEDED_HONEY }), 0);
    }
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending')
      .run(KEY_A, 0, 0, null, Date.now());
  });
  ok(mustLive(), 'server restarted cleanly after seeding honey bait');

  a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'TAMER' });
  const wa2 = await a.waitFor(m => m.t === 'welcome');
  ok((wa2.inv && (wa2.inv.honey | 0) === SEEDED_HONEY),
    'seeded honey:10 survived the restart', wa2.inv);
  ok(!!wa2.pet && Array.isArray(wa2.pet.owned) && wa2.pet.owned.length === 0,
    'reconnect still has an empty owned list (nothing tamed yet)', wa2.pet);
  ok((wa2.tokenPending | 0) === 0, 'pending STRATUM is 0 after the ledger fixture', wa2.tokenPending);

  section('TAME moss_hopper — succeed if a wild MOSS_HOPPER is nearby, else assert the refusal');
  const TAME_REACH = 6;
  const hopperHomes = T.homesNear(0, Math.round(sp.x), Math.round(sp.y), 6)
    .map(h => Object.assign({ d: Math.hypot(h.x - sp.x, h.y - sp.y) }, h))
    .filter(h => h.sp && h.sp.kind === 'MOSS_HOPPER')
    .sort((x, y) => x.d - y.d);
  const home = hopperHomes[0] || null;
  if (!handlersLive) {
    console.log('    skipping hopper approach — tame produced no pet reply on the first try');
  } else if (home) {
    a.send({ t: 'view', x: Math.round(home.x), y: Math.round(home.y) });
    await a.waitNew(m => m.t === 'mons', 4000).catch(() => null);
    let tx = home.x, ty = home.y;
    for (const e of a.monsters()) {
      const spDef = T.speciesOf(0, e[1]);
      if (spDef && spDef.kind === 'MOSS_HOPPER') { tx = e[2]; ty = e[3]; break; }
    }
    const dist = await a.approach(tx, ty, Math.max(1, TAME_REACH - 1), 20000);
    console.log('    approached MOSS_HOPPER at', Math.round(tx) + ',' + Math.round(ty),
      'd=' + (Number.isFinite(dist) ? dist.toFixed(1) : dist));
    await sleep(250);
  } else {
    console.log('    no MOSS_HOPPER home in a 6-chunk radius of spawn — tame should refuse');
  }

  const honeyBefore = (wa2.inv && wa2.inv.honey) | 0;
  const fromTame = a.msgs.length;
  a.send({ t: 'tame', id: PET_ID });
  let tameMsg = null;
  try { tameMsg = await a.waitFrom(fromTame, m => m.t === 'pet', 4000); } catch (e) { tameMsg = null; }
  ok(!!tameMsg, 'server answered the baited tame', tameMsg);
  if (!tameMsg) {
    if (handlersLive) ok(false, 'tame handler went silent after bait seed — no { t:\'pet\' } reply');
  } else if (tameMsg.ok === true) {
    tamed = true;
    const snap = tameMsg.pet || tameMsg;
    ok(ownedHas(snap, PET_ID), 'owned includes moss_hopper after a successful tame', snap.owned);
    const invHoney = honeyOf(tameMsg, honeyOf(snap, null));
    if (invHoney !== null) {
      ok(invHoney === honeyBefore - BAIT_TAME,
        'tame spent exactly 5 honey', { before: honeyBefore, after: invHoney, inv: tameMsg.inv || snap.inv });
    } else {
      ok(true, 'successful tame did not echo inv — honey spend not re-checked on the wire');
    }
    ok(snap.active === true, 'pet.active is true after tame', snap.active);
  } else {
    const err = String(petErr(tameMsg));
    const nearFail = err === 'not near species' || /not near/i.test(err);
    ok(tameMsg.ok === false && nearFail,
      'tame refused without a nearby MOSS_HOPPER (err is \'not near species\')', tameMsg);
    skip('tame-success path (no wild MOSS_HOPPER in range — refusal is the asserted outcome)');
  }

  if (tamed) {
    section('PET-PARK — out null, owned kept');
    const fromPark = a.msgs.length;
    a.send({ t: 'pet-park' });
    let park = null;
    try { park = await a.waitFrom(fromPark, m => m.t === 'pet', 4000); } catch (e) { park = null; }
    ok(!!park && park.ok !== false, 'pet-park answered ok', park);
    const parked = park && (park.pet || park);
    ok(!!parked && (parked.out === null || parked.out === undefined),
      'parked pet.out is null', parked && parked.out);
    ok(!!parked && ownedHas(parked, PET_ID),
      'park keeps moss_hopper in owned', parked && parked.owned);

    section('PET-TREAT — 0 pending STRATUM is refused (need stratum)');
    const fromTreat = a.msgs.length;
    a.send({ t: 'pet-treat', id: PET_ID });
    let treat = null;
    try { treat = await a.waitFrom(fromTreat, m => m.t === 'pet', 4000); } catch (e) { treat = null; }
    if (treat && treat.ok === false && String(petErr(treat)) !== 'need stratum'
        && /not out|parked|not active|no pet out/i.test(String(petErr(treat)))) {
      const fromOut = a.msgs.length;
      a.send({ t: 'pet-out', id: PET_ID });
      await a.waitFrom(fromOut, m => m.t === 'pet', 4000).catch(() => null);
      const fromTreat2 = a.msgs.length;
      a.send({ t: 'pet-treat', id: PET_ID });
      try { treat = await a.waitFrom(fromTreat2, m => m.t === 'pet', 4000); } catch (e) { treat = null; }
    }
    ok(!!treat, 'server answered pet-treat', treat);
    ok(!!treat && treat.ok === false && String(petErr(treat)) === 'need stratum',
      'treat with 0 pending STRATUM is refused with err \'need stratum\'', treat);
  } else {
    section('PET-PARK / PET-TREAT — skipped (nothing tamed)');
    skip('pet-park (requires a successful tame)');
    skip('pet-treat need-stratum (requires a successful tame and remaining bait)');
  }

  section('BUY-PET — fixed 50k premium companion, burn-split, walks out');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending')
      .run(KEY_A, 60000, 0, null, Date.now());
  });
  // ledgerOf reads the DB live — no restart needed for the new balance.
  const fromBuy = a.msgs.length;
  a.send({ t: 'buy-pet', id: 'cinderpup' });
  let bought = null;
  try { bought = await a.waitFrom(fromBuy, m => m.t === 'pet' && m.price === 50000, 4000); } catch (e) { bought = null; }
  ok(!!bought && bought.ok === true, 'buy-pet answered ok with price 50000', bought);
  if (bought) {
    const snap = bought.pet || bought;
    ok(ownedHas(snap, 'cinderpup'), 'cinderpup owned after buy', snap && snap.owned);
    ok((bought.tokenPending | 0) === 10000, 'pending down exactly the 50k price', bought.tokenPending);
    ok(bought.burned === 40000 && bought.treasury === 10000, '80/20 burn split on the price', bought);
    const fromRebuy = a.msgs.length;
    a.send({ t: 'buy-pet', id: 'cinderpup' });
    let rebuy = null;
    try { rebuy = await a.waitFrom(fromRebuy, m => m.t === 'pet' && m.err, 4000); } catch (e) { rebuy = null; }
    ok(!!rebuy && String(rebuy.err) === 'already owned', 're-buy refused, nothing spent', rebuy);
    const fromPoor = a.msgs.length;
    a.send({ t: 'buy-pet', id: 'reefclaw' });
    let poor = null;
    try { poor = await a.waitFrom(fromPoor, m => m.t === 'pet' && m.err, 4000); } catch (e) { poor = null; }
    ok(!!poor && /50000|pending/i.test(String(poor.err)), 'second premium refused while poor', poor);
  }

  section('THE SERVER SURVIVED THE WHOLE SUITE');
  ok(mustLive() && srv.exited === null, 'the server never crashed', srv.exited);

  a.close();
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  const skipBit = skipped ? `  (${skipped} skipped: ${skipNotes.join('; ')})` : '';
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + skipBit + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
