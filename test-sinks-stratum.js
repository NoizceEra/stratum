'use strict';
/**
 * test-sinks-stratum.js — new STRATUM drains, wired end to end.
 *
 * Covers the three drains added for buy/spend pressure (all through pending
 * STRATUM, all with real wire responses, all with real fee math):
 *   1. buy-vanity: Gilded Band (100) + Ember Cloak (250) bought, Starlight Scarf
 *      (500) refused as unaffordable, re-buy refused as already-owned, ownership
 *      persists across restart, set-look equips a bought item and still strips
 *      an unbought one.
 *   2. refill-will: placing a tile drains will below max, refill restores 240
 *      for 10 STRATUM (8 burned / 2 treasury), full will refuses.
 *   3. shop-list fee: a listing costs 5 pending STRATUM straight to the treasury.
 *
 * Real server, real WebSocket clients, no mocks — same shape as every other
 * *-integration.js file. Spawns its own server on an ephemeral port with its
 * own DB — never 8090, never the live DB.
 *
 *   node test-sinks-stratum.js      exits 0 only if every case PASSes
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
const TESTDB = path.join(CWD, 'data', 'test-sinks-stratum.db');
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
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1', STRATUM_SINK_ONCHAIN: '0' }, extraEnv || {}),
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
      let body = '';
      r.on('data', d => body += d); r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
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
/** Server is down between kill and restart — the one window this test may touch the
 *  DB directly, mirroring test-idle-integration.js exactly. */
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

(async function main() {
  console.log('\nSTRATUM new sinks — vanity wardrobe + will refill + listing fee — live server, real wire\n');
  wipe(TESTDB);
  const port0 = await freePort();
  let srv = startServer(port0);
  let port = port0;
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const spawn0 = T.spawnPoint(0);
  const KEY_A = 'sinks-key-AAAA-0001';

  // Establish A's rows for real, then seed 600 pending via the DB-fixture
  // technique (same as test-token-sink-integration.js).
  const a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'SINKER' });
  await a0.waitFor(m => m.t === 'welcome');
  a0.close();
  await sleep(150);

  let r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly to seed fixtures');
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending').run(KEY_A, 600, 0, null, Date.now());
  });
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly after seeding 600 pending');

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'SINKER' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.tokenPending === 600, 'seeded 600 pending survived the restart', wa.tokenPending);
  ok(Array.isArray(wa.customization.accessories) && wa.customization.accessories.some(x => x.id === 'gilded-band' && x.priceStratum === 100),
    'welcome advertises vanity prices', wa.customization.accessories.filter(x => x.priceStratum).length);

  // --------------------------------------------------------------------------
  section('BUY-VANITY — burn sink with ownership');
  // --------------------------------------------------------------------------
  a.send({ t: 'buy-vanity', id: 'gilded-band' });
  const bought = await a.waitNew(m => m.t === 'vanity-bought');
  ok(bought.ok === true && bought.price === 100 && bought.tokenPending === 500, 'Gilded Band bought for 100, pending 500', bought);
  ok(bought.burned === 80 && bought.treasury === 20, '80/20 burn split on the vanity price', bought);

  a.send({ t: 'buy-vanity', id: 'gilded-band' });
  const rebuy = await a.waitNew(m => m.t === 'vanity-bought');
  ok(rebuy.ok === false && rebuy.err === 'already owned' && rebuy.tokenPending === 500, 're-buy refused, nothing spent', rebuy);

  a.send({ t: 'buy-vanity', id: 'slayers-hood' });
  const notSale = await a.waitNew(m => m.t === 'vanity-bought');
  ok(notSale.ok === false && notSale.err === 'not for sale', 'achievement cosmetic is not for sale', notSale);

  a.send({ t: 'buy-vanity', id: 'ember-cloak' });
  const bought2 = await a.waitNew(m => m.t === 'vanity-bought');
  ok(bought2.ok === true && bought2.tokenPending === 250, 'Ember Cloak bought for 250, pending 250', bought2);

  a.send({ t: 'buy-vanity', id: 'starlight-scarf' });
  const poor = await a.waitNew(m => m.t === 'vanity-bought');
  ok(poor.ok === false && poor.err === 'cannot afford' && poor.tokenPending === 250, '500-price scarf refused at 250 pending', poor);

  a.send({ t: 'set-look', paletteId: 'moss', hat: 'gilded-band' });
  const look = await a.waitNew(m => m.t === 'look');
  ok(look.hat === 'gilded-band', 'bought vanity equips via set-look', look);

  a.send({ t: 'set-look', paletteId: 'moss', cloak: 'ember-cloak', scarf: 'starlight-scarf' });
  const look2 = await a.waitNew(m => m.t === 'look');
  ok(look2.cloak === 'ember-cloak' && look2.scarf === null, 'owned equips, unbought vanity stripped', look2);

  const stats1 = await getStats(port);
  ok(stats1.treasury && stats1.treasury.STRATUM === 70, '/api/stats treasury holds 20+50 sink slices', stats1.treasury);
  ok(stats1.colonyQuota === 280, 'colony quota holds 80+200 burned', stats1.colonyQuota);

  // --------------------------------------------------------------------------
  section('OWNERSHIP PERSISTS — reboot, still owned');
  // --------------------------------------------------------------------------
  a.close();
  await sleep(150);
  r = await restart(srv, port);
  srv = r.srv; port = r.port;
  ok(mustLive(), 'server restarted cleanly after vanity buys');
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: KEY_A, name: 'SINKER' });
  const wa2 = await a2.waitFor(m => m.t === 'welcome');
  ok(wa2.tokenPending === 250, 'pending survived the restart', wa2.tokenPending);
  a2.send({ t: 'set-look', paletteId: 'moss', hat: 'gilded-band' });
  const look3 = await a2.waitNew(m => m.t === 'look');
  ok(look3.hat === 'gilded-band', 'vanity ownership survived the restart', look3);

  // --------------------------------------------------------------------------
  section('REFILL-WILL — burn sink for will');
  // --------------------------------------------------------------------------
  // Drain will below max with a real placement (dirt-class tile id 1 costs wood,
  // which the starter cache holds). Energy is session-only so this must be live.
  const px = spawn0.x + 1, py = spawn0.y;
  a2.send({ t: 'set', x: px, y: py, m: 1 });
  const placed = await a2.waitNew(m => (m.t === 'you' && m.x === px) || (m.t === 'deny'));
  ok(placed.t === 'you' && (placed.energy | 0) < 240, 'a real placement drained will below max', placed.energy);
  a2.send({ t: 'refill-will' });
  const filled = await a2.waitNew(m => m.t === 'will-filled');
  ok(filled.ok === true && filled.energy === 240 && filled.tokenPending === 240, 'will restored to full for 10 STRATUM', filled);
  ok(filled.burned === 8 && filled.treasury === 2, '80/20 split on the refill price', filled);
  a2.send({ t: 'refill-will' });
  const full = await a2.waitNew(m => m.t === 'will-filled');
  ok(full.ok === false && full.err === 'will already full' && full.tokenPending === 240, 'full will refuses, nothing spent', full);

  // --------------------------------------------------------------------------
  section('LISTING FEE — treasury collector on shop-list');
  // --------------------------------------------------------------------------
  a2.send({ t: 'shop-list', x: px, y: py, item: 'wood', qty: 1, priceItem: 'gold', priceQty: 1 });
  const listed = await a2.waitNew(m => m.t === 'shop-listed');
  ok(listed.id && listed.listingFee === 5 && listed.tokenPending === 235, 'listing took the 5 STRATUM fee, pending 235', listed);

  const stats2 = await getStats(port);
  ok(stats2.treasury && stats2.treasury.STRATUM === 77, 'treasury holds 70+2+5 across all three drains', stats2.treasury);
  ok(stats2.colonyQuota === 288, 'quota holds 280+8 burned', stats2.colonyQuota);
  ok(mustLive(), 'the server never exited during the whole suite');

  a2.close();
  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e && (e.stack || e.message)); process.exit(1); });
