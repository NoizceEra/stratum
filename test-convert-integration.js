'use strict';
/**
 * test-convert-integration.js — play without a wallet, then claim and convert
 * only after one is linked. Fees land in the treasury vault on convert; a claim
 * against the placeholder mint is queued and does not take the fee.
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const Proof = require('./src/wallet-proof.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-convert-integration.db');
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
    // STRATUM_CLAIM_SIGNER_KEY/STRATUM_TREASURY_KEY explicitly blanked: server.js's own
    // loadDotEnv() reads the real local .env off disk on every boot (independent of this
    // test runner's own process.env) and would otherwise smuggle in whatever real signer
    // key a developer has configured locally — making this "queued, not settled" suite
    // silently attempt REAL settlement against the (currently unfunded) live treasury.
    env: Object.assign({}, process.env, {
      PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1',
      STRATUM_MIN_CLAIM_AMOUNT: '4', STRATUM_CLAIM_FEE_BPS: '2500',
      STRATUM_CONVERT_FEE_BPS: '5000', STRATUM_MIN_CONVERT_AMOUNT: '4',
      STRATUM_GOLD_PER_STRM: '10',
      STRATUM_CLAIM_SIGNER_KEY: '', STRATUM_TREASURY_KEY: ''
    }),
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
      req.on('error', () => { if (++tries > 100) return reject(new Error('server never came up')); setTimeout(tick, 150); });
    };
    tick();
  });
}
async function restart(srv) {
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  const p = await freePort();
  const next = startServer(p);
  await waitReady(p);
  return { srv: next, port: p };
}
function withDb(fn) {
  const db = new DatabaseSync(TESTDB);
  try { fn(db); } finally { db.close(); }
}
function getJson(port, pathName) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName }, r => {
      let body = ''; r.on('data', d => body += d);
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
  console.log('\nSTRATUM convert/claim — wallet gate, fees, one wallet one colonist\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  const kp = Keypair.generate();
  const WALLET = kp.publicKey.toBase58();
  const KEY_A = 'convert-key-AAAA-0001';
  const KEY_B = 'convert-key-BBBB-0002';

  section('PLAY — a colonist enters with no wallet');
  let a0 = new Client('A0', port);
  await a0.connect();
  a0.send({ t: 'hello', key: KEY_A, name: 'MINER' });
  const welcome0 = await a0.waitNew(m => m.t === 'welcome');
  ok(!welcome0.tokenWallet, 'welcome does not require a wallet', welcome0.tokenWallet);
  ok(welcome0.payout && welcome0.payout.claimBps === 2500 && welcome0.payout.convertBps === 5000,
    'welcome publishes the claim and convert fees', welcome0.payout);
  a0.close();

  let booted = await restart(srv);
  srv = booted.srv; port = booted.port;
  withDb(db => {
    db.prepare('INSERT INTO token_ledger(k,pending,claimed,wallet,updated) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(k) DO UPDATE SET pending=excluded.pending, wallet=NULL').run(KEY_A, 8, 0, null, Date.now());
    const row = db.prepare('SELECT inv FROM player_state WHERE k=?').get(KEY_A);
    const inv = row ? JSON.parse(row.inv) : { wood: 6, ore: 4, herb: 2, crystal: 1, gold: 0 };
    inv.gold = 40;
    if (row) db.prepare('UPDATE player_state SET inv=? WHERE k=?').run(JSON.stringify(inv), KEY_A);
    else db.prepare('INSERT INTO player_state(k,map,x,y,hp,kills,inv,tool) VALUES(?,?,?,?,?,?,?,?)')
      .run(KEY_A, 0, 8, 8, 100, 0, JSON.stringify(inv), 0);
  });
  booted = await restart(srv);
  srv = booted.srv; port = booted.port;

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'MINER' });
  const wa = await a.waitNew(m => m.t === 'welcome');
  ok(wa.tokenPending === 8 && wa.inv.gold === 40, 'seeded gold and pending STRATUM load with no wallet', wa);

  section('GATE — claim and convert refuse until a wallet is linked');
  a.send({ t: 'claim' });
  const noClaim = await a.waitNew(m => m.t === 'claimed');
  ok(noClaim.ok === false && noClaim.err === 'link a wallet first', 'claim without a wallet is refused', noClaim);
  a.send({ t: 'convert', dir: 'to-token' });
  const noConv = await a.waitNew(m => m.t === 'converted');
  ok(noConv.ok === false && noConv.err === 'link a wallet first', 'convert without a wallet is refused', noConv);
  ok(noConv.tokenPending === 8 && noConv.gold === 40, 'a refused convert changes nothing', noConv);

  section('LINK — one wallet binds to this colonist');
  a.send({ t: 'wallet-link', address: WALLET });
  const linked = await a.waitNew(m => m.t === 'wallet-linked');
  ok(linked.address === WALLET && !linked.err, 'unsigned first link still binds a free wallet', linked);

  section('CLAIM — fee is quoted, pending stays until the chain can pay');
  a.send({ t: 'claim' });
  const claimed = await a.waitNew(m => m.t === 'claimed');
  ok(claimed.queued === true && claimed.reason === 'not_configured', 'placeholder mint queues the claim', claimed);
  ok(claimed.amount === 8 && claimed.fee === 2 && claimed.payout === 6, 'claim quotes a 25% fee and the net payout', claimed);
  ok(claimed.tokenPending === 8, 'a queued claim does not take the fee or the balance', claimed);

  section('CONVERT — gold becomes pending STRATUM and the fee hits the vault');
  a.send({ t: 'convert', dir: 'to-token' });
  const conv = await a.waitNew(m => m.t === 'converted' && m.ok === true);
  ok(conv.gross === 4 && conv.fee === 2 && conv.payout === 2 && conv.spentGold === 40,
    '40 gold converts to 4 STRATUM with a 50% fee', conv);
  ok(conv.tokenPending === 10 && conv.gold === 0, 'player keeps the net STRATUM and spends the gold', conv);
  const stats = await getJson(port, '/api/stats');
  ok(stats.treasury && stats.treasury.STRATUM === 2, 'convert fee is collected in the treasury vault', stats.treasury);

  section('WALLETS = PLAYERS — the same wallet cannot bind a second colonist');
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: KEY_B, name: 'OTHER' });
  await b.waitNew(m => m.t === 'welcome');
  b.send({ t: 'wallet-link', address: WALLET });
  const stolen = await b.waitNew(m => m.t === 'wallet-linked');
  ok(stolen.err === 'wallet already belongs to another colonist' && !stolen.resumeKey,
    'an unsigned link cannot take a wallet that already has a colonist', stolen);

  b.send({ t: 'wallet-challenge' });
  const ch = await b.waitNew(m => m.t === 'wallet-challenge');
  const sig = Proof.signLink(kp.secretKey, WALLET, KEY_B, ch.nonce);
  b.send({ t: 'wallet-link', address: WALLET, signature: sig, nonce: ch.nonce });
  const resumed = await b.waitNew(m => m.t === 'wallet-linked' && m.resumeKey);
  ok(resumed.resumeKey === KEY_A && resumed.address === WALLET,
    'a real signature resumes the colonist that wallet already is', resumed);

  a.close(); b.close();
  srv.kill('SIGTERM');
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
