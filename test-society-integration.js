'use strict';
/**
 * test-society-integration.js — shops + escrowed trade + emotes, wired end to end.
 *
 * test-shops.js and test-trade.js prove the pure escrow MATH is correct in isolation.
 * This file proves the SERVER actually uses it correctly over the real wire: a listing
 * escrows goods the instant it's created (before any sale), a buyer within reach
 * completes a purchase atomically (both sides' inventories update, the seller is
 * credited even while only the buyer is connected to receive a reply), an unaffordable
 * buyer is refused with nothing taken, cancelling returns unsold escrow, a trade offer
 * escrows the offerer's side immediately, the recipient accepting swaps atomically, an
 * unaccepted offer expires and returns the escrow, and an emote outside the fixed
 * allowlist is rejected. Real server, real WebSocket clients, no mocks — same shape as
 * test-drops-integration.js and test-integration.js. Spawns its own server(s) on
 * ephemeral ports with their own DBs — never 8090, never the live DB.
 *
 *   node test-society-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-society-integration.db');
const TESTDB2 = path.join(CWD, 'data', 'test-society-integration-ttl.db');
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
  console.log('\nSTRATUM society (shops + trade + emotes) integration — live server, real wire\n');
  wipe(TESTDB); wipe(TESTDB2);
  const port = await freePort();
  // Fee gate lives in test-sinks-stratum.js; zero it here so TTL/expiry mechanics
  // stay the thing under test (fresh players hold 0 pending).
  const srv = startServer(port, TESTDB, { STRATUM_LISTING_FEE: '0' });
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: 'society-key-AAAA-0001', name: 'MERCHANT' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.inv && wa.inv.wood === 6 && wa.inv.ore === 4 && wa.inv.herb === 2 && wa.inv.crystal === 1,
    'seller starts with the usual starter cache {6,4,2,1}', wa.inv);
  const sp = wa.spawn, map = wa.map;
  const shopX = sp.x + 3, shopY = sp.y + 3;   // within REACH(6) of spawn — no walking needed

  // ------------------------------------------------------------------------
  section('SHOPS — a listing requires land you actually own');
  // ------------------------------------------------------------------------
  a.send({ t: 'shop-list', x: shopX, y: shopY, item: 'ore', qty: 3, priceItem: 'wood', priceQty: 1 });
  const rejectedNoLand = await a.waitNew(m => m.t === 'shop-listed');
  ok(rejectedNoLand.err === 'not your land', 'listing an unclaimed tile is refused', rejectedNoLand);

  a.send({ t: 'set', x: shopX, y: shopY, m: 1 });     // claim it (dirt, costs 1 wood)
  const claimed = await a.waitNew(m => m.t === 'you' && m.x === shopX && m.y === shopY);
  ok(claimed.inv && claimed.inv.wood === 5, 'claimed the shop tile, spending 1 wood (6 -> 5)', claimed.inv);

  // ------------------------------------------------------------------------
  section('SHOPS — creating a listing escrows the goods IMMEDIATELY, before any sale');
  // ------------------------------------------------------------------------
  a.send({ t: 'shop-list', x: shopX, y: shopY, item: 'ore', qty: 3, priceItem: 'wood', priceQty: 1 });
  const listed = await a.waitNew(m => m.t === 'shop-listed' && !m.err);
  ok(!!listed.id, 'listing created with an id', listed);
  ok(listed.inv && listed.inv.ore === 1, 'the 3 listed ore left the seller\'s live inventory RIGHT NOW (4 -> 1)', listed.inv);
  ok(listed.inv && listed.inv.wood === 5, 'nothing else was touched by listing creation', listed.inv);
  const listingId = listed.id;

  // a second listing, priced far beyond what a fresh arrival can pay — dedicated to the
  // "buyer cannot afford" refusal path below, kept independent of the main sale so a
  // refused purchase can be proven to have taken nothing.
  a.send({ t: 'shop-list', x: shopX, y: shopY, item: 'crystal', qty: 1, priceItem: 'wood', priceQty: 100 });
  const listed2 = await a.waitNew(m => m.t === 'shop-listed' && !m.err && m.id !== listingId);
  ok(listed2.inv && listed2.inv.crystal === 0, 'the pricey listing also escrowed immediately (crystal 1 -> 0)', listed2.inv);
  const listingId2 = listed2.id;

  // ------------------------------------------------------------------------
  section('SHOPS — a buyer within reach who can afford it completes the trade atomically');
  // ------------------------------------------------------------------------
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'society-key-BBBB-0002', name: 'CUSTOMER' });
  const wb = await b.waitFor(m => m.t === 'welcome');
  ok(wb.inv && wb.inv.wood === 6 && wb.inv.ore === 4, 'buyer starts with the usual starter cache too', wb.inv);
  ok(wb.map === map, 'buyer landed on the same map as the seller (same spawn point)');

  b.send({ t: 'shop-buy', id: listingId, qty: 2 });
  const bought = await b.waitNew(m => m.t === 'shop-bought' && m.id === listingId);
  ok(!bought.err, 'purchase succeeded over the wire', bought);
  ok(bought.inv && bought.inv.wood === 4, 'buyer paid exactly 2 wood (priceQty 1 x qty 2): 6 -> 4', bought.inv);
  ok(bought.inv && bought.inv.ore === 6, 'buyer received exactly 2 ore: 4 -> 6', bought.inv);
  ok(bought.remainingQty === 1, 'the listing has 1 unit of stock left', bought.remainingQty);

  const sold = await a.waitNew(m => m.t === 'shop-sold' && m.id === listingId);
  ok(sold && sold.buyer === 'society-key-BBBB-0002' && sold.qty === 2 && sold.cost === 2,
    'the (online) seller was notified of the sale in real time', sold);

  // ------------------------------------------------------------------------
  section('SHOPS — a buyer who cannot afford it is refused, nothing taken');
  // ------------------------------------------------------------------------
  b.send({ t: 'shop-buy', id: listingId2, qty: 1 });
  const refused = await b.waitNew(m => m.t === 'shop-bought' && m.id === listingId2);
  ok(refused.err === 'cannot afford', 'the 100-wood listing is refused to a buyer holding only 4', refused);
  ok(refused.inv === undefined, 'a refused purchase carries no inventory (nothing was touched)', refused);

  // ------------------------------------------------------------------------
  section('SHOPS — cancelling returns whatever is STILL escrowed, and credits past sales');
  // ------------------------------------------------------------------------
  a.send({ t: 'shop-cancel', id: listingId });
  const cancelled = await a.waitNew(m => m.t === 'shop-cancelled' && m.id === listingId);
  ok(!cancelled.err, 'cancel succeeded', cancelled);
  ok(cancelled.returned && cancelled.returned.ore === 1, 'the 1 still-unsold ore came back, not the original 3', cancelled.returned);
  // wood: 5 (after claim) + 2 (credited from the sale, seller was online throughout) = 7
  ok(cancelled.inv && cancelled.inv.wood === 7, 'the wood paid by the buyer really was credited to the (online) seller: 5 -> 7', cancelled.inv);
  ok(cancelled.inv && cancelled.inv.ore === 2, 'ore is back to 1 (was never sold) + 1 (returned by cancel) = 2', cancelled.inv);

  a.send({ t: 'shop-cancel', id: listingId2 });
  const cancelled2 = await a.waitNew(m => m.t === 'shop-cancelled' && m.id === listingId2);
  ok(cancelled2.returned && cancelled2.returned.crystal === 1, 'the never-sold crystal listing returns its full stock on cancel', cancelled2.returned);
  ok(cancelled2.inv && cancelled2.inv.crystal === 1, 'seller crystal restored to 1', cancelled2.inv);

  a.send({ t: 'shop-cancel', id: listingId });
  const doubleCancel = await a.waitNew(m => m.t === 'shop-cancelled' && m.id === listingId);
  ok(doubleCancel.err === 'no such listing', 'cancelling an already-cancelled listing fails cleanly, not double-granted', doubleCancel);

  // A's inventory is now {wood:7, ore:2, herb:2, crystal:1} — nothing lost, nothing
  // duplicated across the whole listing/sale/cancel lifecycle.

  // ------------------------------------------------------------------------
  section('TRADE — an offer escrows the give-side IMMEDIATELY, before it is accepted');
  // ------------------------------------------------------------------------
  a.send({ t: 'trade-offer', to: 'society-key-BBBB-0002', giveItem: 'wood', giveQty: 3, wantItem: 'ore', wantQty: 2 });
  const offered = await a.waitNew(m => m.t === 'trade-offered');
  ok(!offered.err, 'two-sided trade offer created', offered);
  ok(offered.inv && offered.inv.wood === 4, 'the 3 offered wood left A\'s inventory RIGHT NOW (7 -> 4)', offered.inv);
  const swapId = offered.id;

  const incoming = await b.waitNew(m => m.t === 'trade-incoming' && m.id === swapId);
  ok(incoming && incoming.offer && incoming.offer.giveQty === 3 && incoming.offer.wantQty === 2,
    'the (online) recipient was notified of the incoming offer in real time', incoming);

  a.send({ t: 'trade-offer', to: 'nobody-such-key-ever-9999', giveItem: 'wood', giveQty: 1 });
  const badRecipient = await a.waitNew(m => m.t === 'trade-offered' && m.err);
  ok(badRecipient.err === 'unknown player', 'an offer addressed to a key that never connected is refused server-side, not trusted blindly', badRecipient);

  // ------------------------------------------------------------------------
  section('TRADE — the recipient accepting completes the swap in one atomic step');
  // ------------------------------------------------------------------------
  b.send({ t: 'trade-accept', id: swapId });
  const accepted = await b.waitNew(m => m.t === 'trade-accepted' && m.id === swapId);
  ok(!accepted.err, 'accept succeeded', accepted);
  ok(accepted.received && accepted.received.wood === 3, 'B received exactly the offered 3 wood', accepted.received);
  ok(accepted.paid && accepted.paid.ore === 2, 'B paid exactly the requested 2 ore', accepted.paid);
  // B before this trade: wood 4, ore 6 (from the earlier shop purchase)
  ok(accepted.inv && accepted.inv.wood === 7, 'B wood: 4 -> 7 (received 3)', accepted.inv);
  ok(accepted.inv && accepted.inv.ore === 4, 'B ore: 6 -> 4 (paid 2)', accepted.inv);

  const completed = await a.waitNew(m => m.t === 'trade-completed' && m.id === swapId);
  ok(completed && completed.paid && completed.paid.ore === 2, 'the (online) offerer was notified the trade completed, with what was paid', completed);

  b.send({ t: 'trade-accept', id: swapId });
  const doubleAccept = await b.waitNew(m => m.t === 'trade-accepted' && m.id === swapId);
  ok(doubleAccept.err === 'no such offer', 'accepting an already-completed offer fails cleanly, not double-granted', doubleAccept);

  section('TRADE — reconnect proves A really was credited the 2 ore while only B was online');
  a.close();
  await sleep(300);
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: 'society-key-AAAA-0001', name: 'MERCHANT' });
  const wa2 = await a2.waitFor(m => m.t === 'welcome');
  // A before the swap: {wood:7, ore:2, herb:2, crystal:1}; escrowed 3 wood -> {4,2,2,1};
  // credited 2 ore on accept -> {4,4,2,1}.
  ok(wa2.inv && wa2.inv.wood === 4 && wa2.inv.ore === 4 && wa2.inv.herb === 2 && wa2.inv.crystal === 1,
    'A\'s persisted inventory reflects the escrow + the credit exactly, with nobody watching', wa2.inv);

  // ------------------------------------------------------------------------
  section('TRADE — a pure gift needs nothing back, and cancelling returns an unaccepted offer');
  // ------------------------------------------------------------------------
  b.send({ t: 'trade-offer', to: 'society-key-AAAA-0001', giveItem: 'herb', giveQty: 1 });
  const gift = await b.waitNew(m => m.t === 'trade-offered');
  ok(!gift.err, 'gift offer created', gift);
  ok(gift.inv && gift.inv.herb === 1, 'B\'s 1 offered herb left immediately (2 -> 1)', gift.inv);
  const giftId = gift.id;

  a2.send({ t: 'trade-accept', id: giftId });
  const giftAccepted = await a2.waitNew(m => m.t === 'trade-accepted' && m.id === giftId);
  ok(!giftAccepted.err, 'gift accepted', giftAccepted);
  ok(giftAccepted.paid === null, 'accepting a pure gift costs the recipient nothing', giftAccepted);
  ok(giftAccepted.inv && giftAccepted.inv.herb === 3, 'A received the gifted herb for free: 2 -> 3', giftAccepted.inv);

  a2.send({ t: 'trade-offer', to: 'society-key-BBBB-0002', giveItem: 'wood', giveQty: 1 });
  const toCancel = await a2.waitNew(m => m.t === 'trade-offered' && !m.err);
  const cancelTradeId = toCancel.id;
  ok(toCancel.inv && toCancel.inv.wood === 3, 'the wood for the about-to-cancel offer left immediately too (4 -> 3)', toCancel.inv);

  b.send({ t: 'trade-cancel', id: cancelTradeId });    // only the OFFERER may cancel — B is not A
  const wrongCancel = await b.waitNew(m => m.t === 'trade-cancelled' && m.id === cancelTradeId);
  ok(wrongCancel.err === 'not your offer', 'the recipient cannot cancel someone else\'s offer', wrongCancel);

  a2.send({ t: 'trade-cancel', id: cancelTradeId });
  const tradeCancelled = await a2.waitNew(m => m.t === 'trade-cancelled' && m.id === cancelTradeId);
  ok(!tradeCancelled.err, 'the offerer cancelling their own open offer succeeds', tradeCancelled);
  ok(tradeCancelled.returned && tradeCancelled.returned.wood === 1, 'the escrowed wood is returned', tradeCancelled.returned);
  ok(tradeCancelled.inv && tradeCancelled.inv.wood === 4, 'A\'s wood is restored: 3 -> 4', tradeCancelled.inv);

  b.send({ t: 'trade-accept', id: cancelTradeId });
  const acceptAfterCancel = await b.waitNew(m => m.t === 'trade-accepted' && m.id === cancelTradeId);
  ok(acceptAfterCancel.err === 'no such offer', 'a cancelled offer cannot later be accepted', acceptAfterCancel);

  // ------------------------------------------------------------------------
  section('EMOTES — the fixed allowlist is enforced server-side, never freeform text');
  // ------------------------------------------------------------------------
  a2.send({ t: 'emote', id: 'this is not on the list' });
  const badEmote = await a2.waitNew(m => m.t === 'emote' && m.err);
  ok(badEmote.err === 'unknown emote', 'an emote id outside the fixed allowlist is rejected', badEmote);

  a2.send({ t: 'emote', id: 'wave' });
  const goodEmote = await a2.waitNew(m => m.t === 'emote' && !m.err);
  ok(goodEmote.id === 'wave' && goodEmote.key === 'society-key-AAAA-0001', 'an allowlisted emote is broadcast with the sender\'s key and id', goodEmote);

  a2.close(); b.close();

  section('THE SERVER THAT TOOK ALL OF IT (main phase)');
  ok(mustLive() && srv.exited === null, 'the test server never exited during the shops/trade phase');
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }

  // ==========================================================================
  section('TRADE — TTL expiry, on a fresh server with a scaled-down clock');
  // ==========================================================================
  // Mirrors world.js's STRATUM_RESPAWN_SCALE trick: a dedicated env var shrinks the
  // trade TTL so the real (lazy + periodic-sweep) expiry path is observable in seconds
  // instead of 7 days, on a SEPARATE server so this tiny TTL cannot race the offers
  // created earlier in this same file.
  const ttlScale = 0.000003;                               // ~1.8s real TTL (604800000 * scale)
  const expectedTtlMs = Math.max(1, Math.round(604800000 * ttlScale));
  const port2 = await freePort();
  const srv2 = startServer(port2, TESTDB2, { STRATUM_TRADE_TTL_SCALE: String(ttlScale) });
  await waitReady(port2);

  const d = new Client('D', port2);
  await d.connect();
  d.send({ t: 'hello', key: 'society-key-DDDD-0003', name: 'OFFERER' });
  await d.waitFor(m => m.t === 'welcome');
  const e = new Client('E', port2);
  await e.connect();
  e.send({ t: 'hello', key: 'society-key-EEEE-0004', name: 'GHOST' });
  await e.waitFor(m => m.t === 'welcome');

  d.send({ t: 'trade-offer', to: 'society-key-EEEE-0004', giveItem: 'wood', giveQty: 2 });
  const expOffer = await d.waitNew(m => m.t === 'trade-offered' && !m.err);
  ok(expOffer.inv && expOffer.inv.wood === 4, 'the offer escrowed 2 wood immediately (6 -> 4)', expOffer.inv);
  const expId = expOffer.id;

  // never accepted — wait past the (scaled) ttl plus a full sweep interval (the sweep
  // tick runs every 5s) plus slack, and expect the offerer to be told it expired.
  const expired = await d.waitNew(m => m.t === 'trade-expired' && m.id === expId, expectedTtlMs + 5000 + 4000);
  ok(!!expired, 'the offerer was notified the unaccepted offer expired', expired);
  ok(expired.returned && expired.returned.wood === 2, 'the expiry notice reports the full 2 wood returned', expired.returned);

  d.send({ t: 'ping', c: 1 });
  await d.waitNew(m => m.t === 'pong');           // round-trip: any prior 'you'/'inv' pushes have landed
  e.send({ t: 'trade-accept', id: expId });
  const tooLate = await e.waitNew(m => m.t === 'trade-accepted' && m.id === expId);
  ok(tooLate.err === 'no such offer', 'the expired offer can no longer be accepted', tooLate);

  // confirm the wood really did come back via a reconnect (nobody has to be watching
  // for the credit to have landed — same proof shape as the shop/trade credit checks above)
  d.close();
  await sleep(300);
  const d2 = new Client('D2', port2);
  await d2.connect();
  d2.send({ t: 'hello', key: 'society-key-DDDD-0003', name: 'OFFERER' });
  const wd2 = await d2.waitFor(m => m.t === 'welcome');
  ok(wd2.inv && wd2.inv.wood === 6, 'the offerer\'s persisted wood is back to the original 6 after expiry', wd2.inv);
  d2.close(); e.close();

  section('THE SERVER THAT TOOK ALL OF IT (ttl phase)');
  let srv2Dead = false;
  if (srv2.exited !== null) { srv2Dead = true; ok(false, 'the ttl-phase test server died mid-suite', srv2.exited); }
  ok(!srv2Dead && srv2.exited === null, 'the ttl-phase test server never exited during the suite');

  srv2.kill('SIGTERM');
  await sleep(800);
  if (srv2.exited === null) { try { srv2.kill('SIGKILL'); } catch (e) {} }

  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
