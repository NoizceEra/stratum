'use strict';
/**
 * test-customization-integration.js — customization.js, wired end to end.
 *
 * test-customization.js proves the MODULE is pure and correct. This file proves the
 * SERVER actually uses it: a fresh player gets a sensible default look, a valid free
 * palette change sticks and is broadcast to a nearby bystander, an unowned accessory is
 * silently stripped rather than applied, and after really unlocking an achievement (a
 * real travel to map 1, which is the cheapest achievement to trigger over the wire —
 * no resources to gather), the accessory it grants can then be equipped.
 * Spawns its own server on an ephemeral port with its own DB
 * (data/test-customization.db) — never 8090, never the live DB.
 *
 *   node test-customization-integration.js      exits 0 only if every case PASSes
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const CU = require('./src/customization.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-customization.db');
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
    env: { ...process.env, PORT: String(port), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '1' },
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
  console.log('\nSTRATUM customization integration — live server, real wire\n');
  wipe(TESTDB);
  const port = await freePort();
  const srv = startServer(port);
  await waitReady(port);
  let srvDead = false;
  const mustLive = () => { if (srv.exited !== null) { srvDead = true; ok(false, 'test server died mid-suite', srv.exited); } return !srvDead; };

  section('/api/palettes — the gate screen can fetch swatches before connecting');
  const palettesBody = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/palettes' }, res => {
      let buf = ''; res.on('data', d => buf += d); res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
  let palettesJson = null; try { palettesJson = JSON.parse(palettesBody); } catch (e) {}
  ok(Array.isArray(palettesJson) && palettesJson.length >= 24, '/api/palettes returns the curated palette list', palettesJson && palettesJson.length);
  ok(palettesJson && palettesJson.every(p => typeof p.id === 'string' && typeof p.bodyHue === 'number' && typeof p.trimHue === 'number'),
    'each palette carries id/bodyHue/trimHue');

  const keyA = 'custom-integ-key-A';
  const a = new Client('A', port);
  await a.connect();

  section('WELCOME — a fresh player gets a sensible default look');
  a.send({ t: 'hello', key: keyA, name: 'DRESSER' });
  const welcomeA = await a.waitFor(m => m.t === 'welcome');
  ok(welcomeA.look && typeof welcomeA.look.paletteId === 'string' && !!CU.paletteOf(welcomeA.look.paletteId),
    'welcome carries a look with a real palette id', welcomeA.look);
  ok(welcomeA.look.hat === null && welcomeA.look.cloak === null && welcomeA.look.scarf === null,
    'a fresh player starts with no accessories equipped', welcomeA.look);
  ok(welcomeA.customization && Array.isArray(welcomeA.customization.palettes) && welcomeA.customization.palettes.length >= 24,
    'welcome carries the full palette catalog');
  ok(welcomeA.customization && Array.isArray(welcomeA.customization.accessories) && welcomeA.customization.accessories.length >= 6,
    'welcome carries the full accessory catalog');
  const gatedAcc = welcomeA.customization.accessories.find(x => x.unlockedBy);
  ok(!!gatedAcc && typeof gatedAcc.unlockDesc === 'string' && gatedAcc.unlockDesc.length > 0,
    'a gated accessory carries its unlock achievement\'s desc for the wardrobe tooltip', gatedAcc);

  section('SET-LOOK — a valid free palette sticks and reflects to a nearby bystander');
  const b = new Client('B', port);
  await b.connect();
  b.send({ t: 'hello', key: 'custom-integ-key-B', name: 'WATCHER' });
  await b.waitFor(m => m.t === 'welcome');
  // both players start at the same spawn point, well inside the 72-tile presence radius
  const chosenPalette = CU.ALL_PALETTES.find(p => p.id !== welcomeA.look.paletteId) || CU.ALL_PALETTES[0];
  a.send({ t: 'set-look', paletteId: chosenPalette.id });
  const lookAck = await a.waitFor(m => m.t === 'look');
  ok(lookAck.paletteId === chosenPalette.id && lookAck.bodyHue === chosenPalette.bodyHue,
    'the server echoes the accepted look back to the requester', lookAck);

  const seenByB = await b.waitNew(m => m.t === 'players' && m.list && m.list.some(row => row[0] === keyA), 3000).catch(() => null);
  ok(!!seenByB, 'the bystander received a presence update after the look change', seenByB);
  const rowForA = seenByB && seenByB.list.find(row => row[0] === keyA);
  ok(!!rowForA && rowForA[4] === chosenPalette.bodyHue && rowForA[5] === chosenPalette.trimHue,
    'the bystander sees the new bodyHue/trimHue for A', rowForA);

  section('SET-LOOK — an accessory not yet unlocked is silently stripped, not applied');
  a.send({ t: 'set-look', paletteId: chosenPalette.id, hat: gatedAcc.id });
  const strippedAck = await a.waitFor(m => m.t === 'look' && m.paletteId === chosenPalette.id, 3000);
  ok(strippedAck.hat === null, 'the unowned accessory did not make it into the applied look', strippedAck);

  section('UNLOCK — a real achievement over the wire (wayfarer: visit map 1), then equip its cosmetic');
  const wardenAcc = welcomeA.customization.accessories.find(x => x.unlockedBy === 'wayfarer');
  ok(!!wardenAcc, 'the catalog includes an accessory unlocked by "wayfarer" (cheap: just travel)', wardenAcc);
  a.send({ t: 'travel', map: 1 });
  await a.waitFor(m => m.t === 'arrived' && m.map === 1);
  const unlockMsg = await a.waitFor(m => m.t === 'achievement' && m.id === 'wayfarer', 4000).catch(() => null);
  ok(!!unlockMsg, 'the server sent an "achievement" unlock for wayfarer after the real travel', unlockMsg);

  const reqSlot = {}; reqSlot[wardenAcc.slot] = wardenAcc.id;
  a.send(Object.assign({ t: 'set-look', paletteId: chosenPalette.id }, reqSlot));
  const grantedAck = await a.waitFor(m => m.t === 'look' && m[wardenAcc.slot] === wardenAcc.id, 3000).catch(() => null);
  ok(!!grantedAck, 'after the real unlock, requesting the newly-unlocked accessory now succeeds', grantedAck);

  section('RECONNECT — the persisted look survives a new connection');
  a.close();
  await sleep(300);
  const a2 = new Client('A2', port);
  await a2.connect();
  a2.send({ t: 'hello', key: keyA, name: 'DRESSER' });
  const welcomeA2 = await a2.waitFor(m => m.t === 'welcome');
  ok(welcomeA2.look.paletteId === chosenPalette.id && welcomeA2.look[wardenAcc.slot] === wardenAcc.id,
    'the reconnected player keeps the palette and the unlocked accessory they equipped', welcomeA2.look);
  a2.close();
  b.close();

  section('THE SERVER THAT TOOK ALL OF IT');
  ok(mustLive() && srv.exited === null, 'the server never exited during the whole suite');

  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
