'use strict';
/**
 * test-hardening.js — adversarial suite for STRATUM's server.
 *
 * Every case here is a REAL attack against a REAL server process: this file spawns its
 * own `server.js` child on an ephemeral port with its own throwaway DB
 * (data/test-hardening.db) and speaks raw RFC 6455 frames at it. It never touches the
 * live world DB, never touches port 8090, and never imports the server (a unit test of
 * a hardening layer proves nothing — the point is that the process is still serving
 * afterwards).
 *
 *   node test-hardening.js        exits 0 only if every case PASSes
 *
 * No dependencies: node:http + node:net + node:crypto, same as the server.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-hardening.db');
const CAPDB = path.join(CWD, 'data', 'test-hardening-cap.db');
const THROWDB = path.join(CWD, 'data', 'test-hardening-throw.db');
const TESTDBS = [TESTDB, CAPDB, THROWDB];
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LIVE_PORT = 8090;                 // the public server. Never touch it.
const HS_IDLE_MS = 3000;                // what we tell the test server to allow pre-hello
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------- fixture --------------------------------------------------------
function wipe(db) { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + s); } catch (e) {} } }

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function startServer(port, env, db) {
  if (port === LIVE_PORT) throw new Error('refusing to run a test server on ' + LIVE_PORT);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PORT: String(port), STRATUM_DB: db || TESTDB, STRATUM_RESPAWN_SCALE: '0.05', ...(env || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.log = '';
  srv.exited = null;
  const cap = (d) => { srv.log += d.toString(); if (srv.log.length > 400000) srv.log = srv.log.slice(-200000); };
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

function stats(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stats', timeout: 4000 }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('stats timeout')));
    req.on('error', reject);
  });
}

// ---------- raw websocket client -------------------------------------------
const OP = { text: 1, close: 8, ping: 9, pong: 10 };

/**
 * Build a client-side (masked) frame. `declared` lies about the payload length in the
 * header while `buf` is what is actually sent — that is exactly the attack we test.
 */
function frame(buf, opcode, declared) {
  const len = buf.length;
  const d = (declared === undefined) ? len : declared;
  const mask = crypto.randomBytes(4);
  let head;
  if (d < 126) { head = Buffer.from([0x80 | opcode, 0x80 | d]); }
  else if (d < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(d, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(d), 2); }
  const body = Buffer.from(buf.map((b, i) => b ^ mask[i & 3]));
  return Buffer.concat([head, mask, body]);
}

class WS {
  constructor(port, tag) {
    this.port = port; this.tag = tag;
    this.msgs = []; this.waiters = []; this.buf = Buffer.alloc(0);
    this.closed = false; this.sawCloseFrame = false; this.pings = 0; this.sendError = null;
  }

  connect(ms) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      const timer = setTimeout(() => { try { req.destroy(); } catch (e) {} reject(new Error(this.tag + ': connect timeout')); }, ms || 5000);
      req.on('upgrade', (res, socket) => {
        clearTimeout(timer);
        const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) return reject(new Error(this.tag + ': bad accept key'));
        this.socket = socket;
        socket.on('data', (d) => { try { this._feed(d); } catch (e) {} });
        socket.on('error', (e) => { this.sendError = e; this.closed = true; });
        socket.on('close', () => { this.closed = true; });
        resolve(this);
      });
      req.on('response', (res) => {          // a refused upgrade answers with plain HTTP
        clearTimeout(timer);
        res.resume();
        const e = new Error(this.tag + ': refused');
        e.statusCode = res.statusCode;
        reject(e);
      });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (op === OP.close) { this.sawCloseFrame = true; continue; }
      if (op === OP.ping) { this.pings++; try { this.sendRaw(frame(payload, OP.pong)); } catch (e) {} continue; }
      if (op === OP.pong) continue;
      if (op !== OP.text) continue;
      let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (!m || typeof m !== 'object') continue;
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => { if (w.test(m)) { w.resolve(m); return false; } return true; });
    }
  }

  sendRaw(buf) {
    if (!this.socket || this.socket.destroyed) { this.closed = true; throw new Error(this.tag + ': socket gone'); }
    this.socket.write(buf);
  }
  sendJSON(o) { this.sendRaw(frame(Buffer.from(JSON.stringify(o), 'utf8'), OP.text)); }
  /** Raw wire text: lets the suite send things JSON.stringify cannot express. */
  sendTextRaw(s) { this.sendRaw(frame(Buffer.from(s, 'utf8'), OP.text)); }

  waitFor(test, ms) {
    const hit = this.msgs.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout')); }, ms || 3000);
    });
  }
  waitNew(test, ms) {
    const from = this.msgs.length;
    const scan = () => { for (let i = from; i < this.msgs.length; i++) if (test(this.msgs[i])) return this.msgs[i]; return null; };
    const hit = scan();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test: () => { const r = scan(); if (r) { w.resolve(r); return true; } return false; }, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout(new)')); }, ms || 3000);
    });
  }
  waitClosed(ms) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms || 4000);
      const done = () => { clearTimeout(t); resolve(true); };
      if (!this.socket) { clearTimeout(t); return resolve(false); }
      this.socket.once('close', done);
      this.socket.once('error', done);
    });
  }
  pos() { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'players' && this.msgs[i].you) return { x: this.msgs[i].you[0], y: this.msgs[i].you[1] }; return null; }
  destroy() { try { this.socket.destroy(); } catch (e) {} this.closed = true; }
}

/** Is the world still serving? HTTP answers AND a fresh client completes a handshake. */
async function alive(port) {
  try {
    const s = await stats(port);
    if (!s || !s.world) return false;
    const c = new WS(port, 'probe');
    await c.connect(4000);
    c.sendJSON({ t: 'hello', key: 'probe-' + crypto.randomBytes(8).toString('hex'), name: 'PROBE' });
    const w = await c.waitFor(m => m.t === 'welcome', 4000);
    c.destroy();
    return !!w;
  } catch (e) { return false; }
}

// ---------- the suite ------------------------------------------------------
(async function main() {
  if (Number(process.env.PORT || 0) === LIVE_PORT) throw new Error('PORT env points at the live server');
  console.log('\nSTRATUM hardening suite — real attacks against a private server process\n');

  const port = await freePort();
  if (port === LIVE_PORT) throw new Error('ephemeral port collided with the live server');
  TESTDBS.forEach(wipe);
  const srv = startServer(port, { STRATUM_HS_IDLE_MS: String(HS_IDLE_MS) }, TESTDB);
  await waitReady(port);
  console.log('[test] private server pid ' + srv.pid + ' on ephemeral :' + port + ' with ' + path.basename(TESTDB) + '\n');

  // 1 ─ oversized frames --------------------------------------------------
  section('1. OVERSIZED FRAME (>64KB)');
  {
    const big = new WS(port, 'big');
    await big.connect();
    big.sendRaw(frame(Buffer.alloc(80 * 1024, 0x41), OP.text));      // honest 80KB text frame
    const cut = await big.waitClosed(5000);
    ok(cut, 'an 80KB frame is rejected and the socket is torn down by the server');
    ok(srv.log.includes('frame too large'), 'the server says why: "frame too large"');
    ok(await alive(port), 'the world is still serving after the oversized frame');

    // a header that PROMISES a huge frame, with almost no payload behind it
    const liar = new WS(port, 'liar');
    await liar.connect();
    liar.sendRaw(frame(Buffer.alloc(16, 0x42), OP.text, 512 * 1024 * 1024));
    const cut2 = await liar.waitClosed(5000);
    ok(cut2, 'a frame declaring 512MB is refused from its header alone (nothing is buffered)');
    ok(await alive(port), 'the world is still serving after the liar');
  }

  // 2 ─ flood -------------------------------------------------------------
  section('2. 10,000-MESSAGE FLOOD');
  {
    const flood = new WS(port, 'flood');
    await flood.connect();
    const one = frame(Buffer.from('{"t":"ping","c":1}', 'utf8'), OP.text);
    let sent = 0;
    for (let i = 0; i < 10000; i++) {
      try { flood.sendRaw(one); sent++; } catch (e) { break; }        // the server may hang up on us mid-flood
      if ((i & 255) === 255) await sleep(1);                         // let the kernel actually push bytes
    }
    const cut = await flood.waitClosed(6000);
    await sleep(300);
    ok(sent > 0, 'the flood really was written to the wire (' + sent + ' frames)');
    ok(cut, 'the connection is cut off by the rate limit mid-flood');
    ok(srv.log.includes('rate limit exceeded'), 'the server blames the rate limit: "rate limit exceeded"');
    ok(srv.exited === null, 'the server process is still running (flood did not crash it)');
    ok(await alive(port), 'the world is still serving new players after the flood');
  }

  // 3 ─ malformed JSON ----------------------------------------------------
  section('3. MALFORMED JSON');
  {
    const bad = new WS(port, 'badjson');
    await bad.connect();
    bad.sendTextRaw('{"t":"ping"');                 // truncated
    bad.sendTextRaw('not json at all');
    bad.sendTextRaw('[]');                          // valid JSON, not a message
    bad.sendTextRaw('{"t":"ping","c":}');           // broken inside
    await sleep(200);
    bad.sendJSON({ t: 'ping', c: 7 });
    const pong = await bad.waitFor(m => m.t === 'pong' && m.c === 7, 2000).catch(() => null);
    ok(pong && pong.c === 7, 'malformed JSON is ignored — the very next message still gets a pong', pong);
    ok(!bad.closed, 'the connection survives malformed JSON');
    bad.destroy();
  }

  // 4 ─ unknown types -----------------------------------------------------
  section('4. UNKNOWN MESSAGE TYPE');
  {
    const unk = new WS(port, 'unknown');
    await unk.connect();
    unk.sendJSON({ t: 'nonsense', x: 1 });
    unk.sendJSON({ t: 'hello2' });
    unk.sendJSON({ t: 42 });
    unk.sendJSON({ t: 'DROP TABLE players' });
    await sleep(200);
    unk.sendJSON({ t: 'ping', c: 9 });
    const pong = await unk.waitFor(m => m.t === 'pong' && m.c === 9, 2000).catch(() => null);
    ok(pong, 'an unknown message type is ignored (never dispatched) and the connection keeps working');
    ok(!unk.msgs.some(m => m.t === 'err'), 'an unknown type is refused without inventing an err on the wire');
    ok(!unk.closed, 'the connection survives unknown types');
    unk.destroy();
  }

  // 5 ─ bad coordinates ---------------------------------------------------
  section('5. NaN / INFINITY / MISSING COORDINATES');
  {
    const mv = new WS(port, 'mover');
    await mv.connect();
    mv.sendJSON({ t: 'hello', key: 'hardening-key-0001', name: 'STONE' });
    const w = await mv.waitFor(m => m.t === 'welcome', 5000);
    ok(!!w && w.world.w === 1024, 'control: the hardened server still completes a normal handshake');
    await sleep(400);
    const before = mv.pos();

    const raws = [
      '{"t":"move","x":1e999,"y":1e999}',        // Infinity (parses as a real number, overflows)
      '{"t":"move","x":-1e999,"y":-1e999}',      // -Infinity
      '{"t":"move"}',                             // missing
      '{"t":"move","x":null,"y":null}',           // null
      '{"t":"move","x":"NaN","y":"NaN"}',         // stringly-typed NaN
      '{"t":"move","x":{},"y":[]}',                // object / array
      '{"t":"move","x":true,"y":false}',           // booleans
      '{"t":"move","x":-99999,"y":-99999}'         // wildly out of range
    ];
    for (const r of raws) mv.sendTextRaw(r);
    await sleep(700);
    const after = mv.pos();
    const moved = (before && after) ? Math.hypot(after.x - before.x, after.y - before.y) : 999;
    ok(moved < 0.001, 'none of the 8 bad moves moved the player (still at ' +
      (after ? after.x + ',' + after.y : '?') + ')', { before, after });
    ok(!mv.closed, 'the connection survives the bad coordinates');

    // positive control: the handler is not simply dead
    const t0 = mv.pos();
    mv.sendJSON({ t: 'move', x: Math.round(t0.x) + 1, y: Math.round(t0.y) + 1 });
    await sleep(600);
    const t1 = mv.pos();
    ok(Math.abs(t1.x - (Math.round(t0.x) + 1)) < 0.05 && Math.abs(t1.y - (Math.round(t0.y) + 1)) < 0.05,
      'control: a VALID move still works (' + t0.x + ',' + t0.y + ' -> ' + t1.x + ',' + t1.y + ')', { t0, t1 });
    mv.destroy();
    await sleep(200);
  }

  // 6 ─ handshake without a key -------------------------------------------
  section('6. HANDSHAKE WITHOUT A KEY');
  {
    const nh = new WS(port, 'nokey');
    await nh.connect();
    nh.sendJSON({ t: 'hello', name: 'NOBODY' });
    const err = await nh.waitFor(m => m.t === 'err', 2500).catch(() => null);
    ok(!!err, 'a hello with no key is answered with an explicit err', err);
    ok(err && typeof err.err === 'string' && /key/i.test(err.err), 'the err says what was wrong: ' + (err && err.err), err && err.err);
    ok(!nh.msgs.some(m => m.t === 'welcome'), 'and no welcome is sent for it');
    nh.destroy();
  }

  // 7 ─ slowloris ---------------------------------------------------------
  section('7. SLOWLORIS / IDLE STALL');
  {
    const stall = new WS(port, 'stall');
    await stall.connect();                    // handshake done, then total silence
    const t0 = Date.now();
    const cut = await stall.waitClosed(HS_IDLE_MS + 4000);
    ok(cut, 'a silently parked connection is closed by the idle timeout after ' +
      Math.round((Date.now() - t0) / 1000) + 's (limit ' + (HS_IDLE_MS / 1000) + 's)');

    const half = net.connect(port, '127.0.0.1');
    await new Promise(r => half.once('connect', r));
    half.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n');   // never finished
    const t1 = Date.now();
    const gone = await new Promise(res => {
      const t = setTimeout(() => res(false), HS_IDLE_MS + 4000);
      const done = () => { clearTimeout(t); res(true); };
      half.once('close', done);
      half.once('error', done);
    });
    try { half.destroy(); } catch (e) {}
    ok(gone, 'a half-finished HTTP upgrade is closed too, after ' + Math.round((Date.now() - t1) / 1000) + 's');
    ok(await alive(port), 'the world is still serving after the stalls');
  }

  // 8 ─ 30 simultaneous connections ---------------------------------------
  section('8. 30 SIMULTANEOUS CONNECTIONS');
  {
    const many = [];
    for (let i = 0; i < 30; i++) many.push(new WS(port, 'multi' + i));
    const conns = await Promise.all(many.map(c => c.connect(8000).then(() => true).catch(() => false)));
    ok(conns.filter(Boolean).length === 30, '30 WebSocket handshakes completed', conns.filter(Boolean).length);
    many.forEach((c, i) => { try { c.sendJSON({ t: 'hello', key: 'multi-key-' + (1000 + i), name: 'M' + i }); } catch (e) {} });
    const welcomes = await Promise.all(many.map(c => c.waitFor(m => m.t === 'welcome', 8000).then(() => true).catch(() => false)));
    ok(welcomes.filter(Boolean).length === 30, 'all 30 played hello and got a welcome', welcomes.filter(Boolean).length);
    const st = await stats(port);
    ok(st.online === 30, 'the world reports exactly 30 players online', st.online);
    ok(st.volatile && st.volatile.monstersKnown > 0, 'the volatile layer is alive alongside them', st.volatile);
    many.forEach(c => c.destroy());
    await sleep(400);
  }

  // 9 ─ aborted mid-handshake --------------------------------------------
  section('9. ABORTED MID-HANDSHAKE SOCKETS');
  {
    for (let i = 0; i < 5; i++) {
      const a = net.connect(port, '127.0.0.1');
      await new Promise(r => a.once('connect', r));
      a.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
        crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      await sleep(60);
      a.destroy();                                   // gone before hello
    }
    const half = net.connect(port, '127.0.0.1');
    await new Promise(r => half.once('connect', r));
    half.write('GET / HTTP'); await sleep(30); half.write(' bollocks'); await sleep(30); half.destroy();

    const nokey = net.connect(port, '127.0.0.1');
    await new Promise(r => nokey.once('connect', r));
    nokey.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');   // no key at all
    await sleep(120);
    nokey.destroy();
    await sleep(400);
    ok(await alive(port), 'aborted / garbage mid-handshake sockets do not crash the server');
    ok(srv.exited === null, 'server process still running after the aborts');
  }

  // 10 ─ per-IP connection cap -------------------------------------------
  section('10. PER-IP CONNECTION CAP');
  {
    const capPort = await freePort();
    const capSrv = startServer(capPort, { STRATUM_MAX_CONN_PER_IP: '4' }, CAPDB);
    await waitReady(capPort);
    const four = [];
    let accepted = 0;
    for (let i = 0; i < 4; i++) {
      const c = new WS(capPort, 'cap' + i);
      if (await c.connect(4000).then(() => true).catch(() => false)) accepted++;
      four.push(c);
    }
    ok(accepted === 4, '4 connections accepted while the cap is 4', accepted);
    const refused = await new WS(capPort, 'capX').connect(4000).then(() => 0).catch(e => e.statusCode || -1);
    ok(refused === 503, 'the 5th connection from the same address is refused with HTTP 503', refused);
    four.forEach(c => c.destroy());
    await sleep(500);
    ok(await alive(capPort), 'the capped server still serves once the sockets are gone');
    capSrv.kill();
    await sleep(300);
  }

  // 11 ─ uncaught exception ----------------------------------------------
  section('11. UNCAUGHT EXCEPTION / UNHANDLED REJECTION');
  {
    const throwPort = await freePort();
    const throwSrv = startServer(throwPort, { STRATUM_TEST_THROW: '1' }, THROWDB);
    await waitReady(throwPort);
    await sleep(1500);                       // the child throws at 700ms; it must survive it
    ok(throwSrv.exited === null, 'the process survived a real uncaughtException (still running)');
    ok(/uncaughtException/.test(throwSrv.log), 'it logged the fault instead of dying: ' + (throwSrv.log.match(/\[fatal\][^\n]*/) || ['(no log)'])[0]);
    ok(await alive(throwPort), 'the world is still serving after the fault');
    throwSrv.kill();
    await sleep(300);
  }

  // 12 ─ the server was never hurt ---------------------------------------
  section('12. THE SERVER THAT TOOK ALL OF IT');
  {
    ok(srv.exited === null, 'the hardened server never exited during the whole suite');
    ok(!/uncaughtException|unhandledRejection/.test(srv.log), 'nothing reached the process-level safety net (nothing threw)');
    ok(/dropped:/.test(srv.log), 'the teardown path really ran (violations were logged, not swallowed)');
    ok(await alive(port), 'final health check: still serving');
  }

  // ---------- teardown ---------------------------------------------------
  srv.kill();
  await sleep(400);
  TESTDBS.forEach(wipe);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\nHARNESS ERROR:', e && (e.stack || e.message), '\n');
  process.exit(2);
});
