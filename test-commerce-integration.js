'use strict';
/**
 * test-commerce-integration.js — dual rewards, wallet linking, claim pipeline, and the
 * shop treasury fee, wired end to end over the real wire.
 *
 * test-rewards.js / test-chain-adapter.js / test-shops.js prove the pure math and the
 * chain-adapter stub in isolation. This file proves the SERVER actually uses them
 * correctly: harvesting grants a real STRM ledger credit, wallet-link validates the
 * address format and persists it, a claim without a linked wallet or with nothing
 * pending is refused, a real claim is recorded (claim_requests) and answers "queued —
 * not configured" WITHOUT losing the pending balance (chain-adapter.js never settles
 * anything today, by design), and a shop sale actually splits into seller/treasury per
 * SHOP_FEE_BPS, visible on /api/stats. Real server, real WebSocket client, no mocks —
 * same shape as test-society-integration.js. Spawns its own server on an ephemeral
 * port with its own DB — never 8090, never the live DB.
 *
 *   node test-commerce-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-commerce-integration.db');
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
function startServer(port, db, extraEnv) {
  if (port === LIVE_PORT) throw new Error('refusing to run a test server on ' + LIVE_PORT);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: Object.assign({}, process.env, { PORT: String(port), STRATUM_DB: db, STRATUM_RESPAWN_SCALE: '1' }, extraEnv || {}),
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
      r.on('data', d => body += d);
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
  console.log('\nSTRATUM commerce integration — rewards, wallet, claim pipeline, shop fee — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  // A deliberately large, obviously-artificial 50% shop fee (vs. the real 2.5% default)
  // so the SPLIT is checkable with starter-cache-sized numbers instead of needing a
  // player to grind out 40+ of something first (2.5% of a small starter-cache purchase
  // floors to 0 — that floor behavior is already proven by test-shops.js's pure-math
  // cases; this integration test's job is only to prove the server actually wires
  // SHOP_FEE_BPS into Shops.buy() and credits both sides, not to re-prove the floor).
  // Same reasoning for the min-claim floor: dropped to 1 so a single real harvest (1-2
  // STRM) clears it, because THIS suite's claim section proves the not_configured/queued
  // wiring and the "balance is never touched" contract, not the floor itself — that gets
  // its own dedicated coverage in test-claim-floor-integration.js against the real default.
  const srv = startServer(port, TESTDB, { STRATUM_SHOP_FEE_BPS: '5000', STRATUM_MIN_CLAIM_AMOUNT: '1' });
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: 'commerce-key-AAAA-0001', name: 'ORE_BARON' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.commerce && typeof wa.commerce.tokenAddress === 'string', 'welcome carries the commerce/token config', wa.commerce);
  ok(wa.commerce && wa.commerce.placeholder === true, 'the shipped token config is still explicitly a placeholder', wa.commerce);
  ok(wa.commerce && typeof wa.commerce.treasuryAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(wa.commerce.treasuryAddress),
    'welcome carries the public treasury wallet address', wa.commerce && wa.commerce.treasuryAddress);
  ok(wa.commerce && !('privateKey' in wa.commerce) && !('signerKey' in wa.commerce),
    'welcome commerce config never includes a private key field', wa.commerce);
  ok(wa.tokenPending === 0, 'a fresh player has never earned any pending STRM', wa.tokenPending);

  const bootStats = await getStats(port);
  ok(bootStats.treasuryWallet === wa.commerce.treasuryAddress,
    '/api/stats exposes the same public treasury wallet as welcome.commerce', bootStats.treasuryWallet);
  ok(bootStats.commerce && bootStats.commerce.treasuryAddress === wa.commerce.treasuryAddress,
    '/api/stats.commerce mirrors the public token+treasury config', bootStats.commerce);
  ok(bootStats.fees && bootStats.fees.shopBps === 5000 && bootStats.fees.parcelBps > 0,
    '/api/stats reports the live fee knobs (this suite forces shop=5000bps)', bootStats.fees);

  // --------------------------------------------------------------------------
  section('REWARDS — a real harvest grants pending STRM, not just materials');
  // --------------------------------------------------------------------------
  const T = require('./public/terrain.js');
  const spawn0 = T.spawnPoint(0);
  let nodeXY = null;
  for (let r = 0; r < 30 && !nodeXY; r++) {
    for (let dy = -r; dy <= r && !nodeXY; dy++) for (let dx = -r; dx <= r && !nodeXY; dx++) {
      const x = spawn0.x + dx, y = spawn0.y + dy;
      if (T.nodeAt(0, x, y)) nodeXY = { x, y };
    }
  }
  ok(!!nodeXY, 'found a real resource node near spawn to harvest', nodeXY);
  a.send({ t: 'move', x: nodeXY.x, y: nodeXY.y });
  await sleep(150);
  a.send({ t: 'harvest', x: nodeXY.x, y: nodeXY.y });
  const harvested = await a.waitNew(m => m.t === 'harvested' && !m.err);
  ok(harvested.tokenPending > 0, 'the harvest granted real pending STRM, not zero', harvested.tokenPending);
  const pendingAfterHarvest = harvested.tokenPending;

  // --------------------------------------------------------------------------
  section('WALLET LINK — address format is validated server-side, never trusted blind');
  // --------------------------------------------------------------------------
  a.send({ t: 'wallet-link', address: 'not-a-real-address' });
  const badLink = await a.waitNew(m => m.t === 'wallet-linked');
  ok(badLink.err === 'invalid address', 'a malformed address is refused, not silently accepted', badLink);

  const realWallet = '0x' + 'c'.repeat(40);
  a.send({ t: 'wallet-link', address: realWallet });
  const goodLink = await a.waitNew(m => m.t === 'wallet-linked' && !m.err);
  ok(goodLink.address === realWallet, 'a well-formed address is linked and echoed back', goodLink);
  ok(goodLink.tokenPending === pendingAfterHarvest, 'linking a wallet does not touch the pending balance', goodLink);

  // --------------------------------------------------------------------------
  section('CLAIM — refused without a wallet or without anything pending');
  // --------------------------------------------------------------------------
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'commerce-key-BBBB-0002', name: 'NO_WALLET' });
  await b.waitFor(m => m.t === 'welcome');
  b.send({ t: 'claim' });
  const noWallet = await b.waitNew(m => m.t === 'claimed');
  ok(noWallet.ok === false && noWallet.err === 'link a wallet first', 'claiming with no linked wallet is refused', noWallet);

  b.send({ t: 'wallet-link', address: '0x' + 'd'.repeat(40) });
  await b.waitNew(m => m.t === 'wallet-linked' && !m.err);
  b.send({ t: 'claim' });
  const nothingPending = await b.waitNew(m => m.t === 'claimed');
  ok(nothingPending.ok === false && nothingPending.err === 'nothing pending', 'claiming with a linked wallet but zero pending is refused', nothingPending);

  // --------------------------------------------------------------------------
  section('CLAIM — a real claim is recorded, answers queued/not_configured, and NEVER loses the balance');
  // --------------------------------------------------------------------------
  a.send({ t: 'claim' });
  const claimed = await a.waitNew(m => m.t === 'claimed', 8000);
  ok(claimed.ok === false, 'a claim is never reported as settled today (chain-adapter.js has no real signer)', claimed);
  ok(claimed.queued === true, 'an unsettled claim is explicitly marked queued, not silently dropped', claimed);
  ok(claimed.reason === 'not_configured', 'the reason is exactly what chain-adapter.js reports', claimed);
  ok(claimed.amount === pendingAfterHarvest, 'the claim amount matches the pending balance at request time', claimed);
  ok(claimed.tokenPending === pendingAfterHarvest, 'the pending balance is UNCHANGED — nothing was spent on an unsettled claim', claimed);

  // a second claim on the same still-pending balance behaves identically (idempotent,
  // not a double-spend — there is nothing to double-spend since nothing ever settled)
  a.send({ t: 'claim' });
  const claimedAgain = await a.waitNew(m => m.t === 'claimed', 8000);
  ok(claimedAgain.amount === pendingAfterHarvest && claimedAgain.tokenPending === pendingAfterHarvest,
    'a repeat claim on the same unsettled balance is stable, not additive', claimedAgain);

  // --------------------------------------------------------------------------
  section('SHOP FEE — a real sale actually splits seller/treasury per SHOP_FEE_BPS');
  // --------------------------------------------------------------------------
  const shopX = spawn0.x + 3, shopY = spawn0.y;
  a.send({ t: 'set', x: shopX, y: shopY, m: 2 });
  const claimedTile = await a.waitNew(m => m.t === 'you' && m.x === shopX && m.y === shopY);
  ok(!claimedTile.err, 'seller claimed land to list a shop on', claimedTile);
  // seller's starter cache has herb:2 — list 1 of it, priced at 4 wood (buyer's starter
  // cache has wood:6, easily affordable) so cost=4 and this server's 50% test fee is a
  // clean, non-floored split: fee=2, sellerGets=2.
  a.send({ t: 'shop-list', x: shopX, y: shopY, item: 'herb', qty: 1, priceItem: 'wood', priceQty: 4 });
  const listed = await a.waitNew(m => m.t === 'shop-listed' && !m.err);
  ok(!!listed.id, 'a 4-wood-for-1-herb listing was created', listed);

  b.send({ t: 'move', x: shopX, y: shopY });
  await sleep(150);
  b.send({ t: 'shop-buy', id: listed.id, qty: 1 });
  const bought = await b.waitNew(m => m.t === 'shop-bought' && m.id === listed.id);
  ok(!bought.err, 'the purchase (cost 4 wood) succeeded', bought);
  ok(bought.cost === 4, 'the buyer paid the full listed cost, unaffected by the fee split', bought.cost);
  ok(bought.fee === 2, '50% of 4 is exactly 2 — the treasury cut reported to the buyer', bought.fee);

  const sold = await a.waitNew(m => m.t === 'shop-sold' && m.id === listed.id);
  ok(sold.cost === 2, 'the seller was credited cost-minus-fee (4-2=2), not the gross price', sold);

  const stats = await getStats(port);
  ok(stats.treasury && stats.treasury.wood === 2, '/api/stats now reports the real treasury balance the fee generated', stats.treasury);
  ok(stats.treasuryWallet === wa.commerce.treasuryAddress,
    'fee revenue and the on-chain treasury wallet are both visible on /api/stats', stats.treasuryWallet);

  mustLive();
  ok(mustLive(), 'the server never exited during the whole suite');
  a.close(); b.close();
  try { srv.kill(); } catch (e) {}
  await sleep(200);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e && (e.stack || e.message));
  process.exit(1);
});
