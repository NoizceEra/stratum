/**
 * test-walls-integration.js — the 'wall' structure, wired end to end.
 *
 * src/idle.js's wall entry is proven pure by test-idle.js (via the catalog/collect
 * assertions that run against every entry in STRUCTURES, wall included). This file
 * proves the SERVER actually enforces the one property that makes a wall different
 * from every other structure: it physically blocks movement, authoritatively, not just
 * as a client-side suggestion. A player builds a wall on their own claimed land, a
 * second player is refused a move onto that tile (the anti-cheat case: the server must
 * reject it even though nothing stops a hostile client from asking), a move onto a free
 * neighbouring tile still works (positive control — the handler is not just dead), the
 * owner tears the wall down through the same named 'release-structure' verb, and once
 * it is gone the tile is walkable again.
 *
 * Real server, real WebSocket clients, no mocks — same shape as test-idle-integration.js.
 * Spawns its own server on an ephemeral port with its own DB
 * (data/test-walls-integration.db) — never 8090, never the live DB.
 *
 *   node test-walls-integration.js      exits 0 only if every case PASSes
 */
'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./public/terrain.js');
const Idle = require('./src/idle.js');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test-walls-integration.db');
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
function structKey(map, x, y) { return map + ':' + (y * T.W + x); }

class Client {
  constructor(tag, port) { this.tag = tag; this.port = port; this.msgs = []; this.waiters = []; this.structs = new Map(); }
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
      if (m.t === 'chunk' && m.structures) for (const s of m.structures) this.structs.set(s.x + ',' + s.y, s);
      if (m.t === 'structure') this.structs.set(m.x + ',' + m.y, m);
      if (m.t === 'structure-gone') this.structs.delete(m.x + ',' + m.y);
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
  /** Authoritative server-side position, from the 10Hz presence tick's `you` field —
   *  same technique test-hardening.js's WS.pos() uses, never trust anything the client
   *  itself predicted. */
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'players' && this.msgs[i].you) {
      return { x: this.msgs[i].you[0], y: this.msgs[i].you[1] };
    }
    return null;
  }
  waitPosChange(ms) {
    const from = this.msgs.length;
    return new Promise((resolve, reject) => {
      const w = {
        test: (m) => {
          if (m.t !== 'players' || !m.you) return false;
          return true;
        }, resolve
      };
      // fresh 'players' ticks only, so a stale one already in msgs is not mistaken for a reply
      const scan = () => { for (let i = from; i < this.msgs.length; i++) if (this.msgs[i].t === 'players' && this.msgs[i].you) return this.msgs[i]; return null; };
      const hit = scan();
      if (hit) return resolve(hit);
      w.test = () => { const r = scan(); if (r) { w.resolve(r); return true; } return false; };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout(pos)')); }, ms || 3000);
    });
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

(async function main() {
  console.log('\nSTRATUM wall structure integration — live server, real wire\n');
  wipe(TESTDB);
  let port = await freePort();
  let srv = startServer(port);
  await waitReady(port);
  const mustLive = () => { if (srv.exited !== null) { ok(false, 'test server died mid-suite', srv.exited); return false; } return true; };

  const KEY_A = 'wall-key-AAAA-0001';
  const KEY_C = 'wall-key-CCCC-0003';

  const a = new Client('A', port);
  await a.connect();
  a.send({ t: 'hello', key: KEY_A, name: 'MASON' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  const map = wa.map, sp = wa.spawn;

  section('CATALOG — the wall rides inside welcome, is a real physical obstacle, not a producer');
  const wallDef = (wa.catalog.structures || []).find(s => s.id === 'wall');
  ok(!!wallDef, 'wall is in the welcome catalog', wa.catalog.structures);
  ok(wallDef && wallDef.blocksMovement === true, 'the catalog marks it blocksMovement:true', wallDef);
  ok(wallDef && wallDef.produces === null, 'it produces nothing — it is not an idle producer', wallDef);
  ok(wallDef && wallDef.cost && wallDef.cost.wood === 4 && wallDef.cost.ore === 4,
    'costs wood:4, ore:4 — same scale as the other tier-0/1 structures', wallDef && wallDef.cost);

  const tx = sp.x + 2, ty = sp.y + 2;
  const skey = structKey(map, tx, ty);

  section('OWNERSHIP — a wall needs the builder\'s own claimed land, same rule as any structure');
  a.send({ t: 'build-structure', x: tx, y: ty, kind: 'wall' });
  const unclaimed = await a.waitNew(m => m.t === 'built', 4000);
  ok(unclaimed && unclaimed.err === 'needs your own claimed land', 'refused on unclaimed ground', unclaimed);

  section('BUILD — claim with grass (herb-only cost) so the wood:4/ore:4 wall cost lands exactly');
  ok(wa.inv.wood === 6 && wa.inv.ore === 4, 'fresh hunter starter cache is wood:6, ore:4 — exactly the wall\'s price', wa.inv);
  a.send({ t: 'set', x: tx, y: ty, m: 2 });               // 2 = grass (terrain.js ID.GRASS), costs herb only
  const claimed = await a.waitNew(m => m.t === 'you' && m.x === tx && m.y === ty, 4000);
  ok(!!claimed && !claimed.err, 'claimed the build tile', claimed);

  a.send({ t: 'build-structure', x: tx, y: ty, kind: 'wall' });
  const built = await a.waitNew(m => m.t === 'built', 4000);
  ok(built && !built.err && built.kind === 'wall', 'the wall was built on A\'s own claimed land', built);
  ok(built && built.inv && built.inv.wood === 2 && built.inv.ore === 0,
    'the build cost (wood:4, ore:4) was deducted, and only that', built && built.inv);

  section('COLLISION — the server refuses to move ANY player onto a walled tile, anti-cheat style');
  const c = new Client('C', port);
  await c.connect();
  c.send({ t: 'hello', key: KEY_C, name: 'WANDERER' });
  await c.waitFor(m => m.t === 'welcome');
  await sleep(250);                                      // let lastMove age so maxStep covers the jump
  // land C right next to the wall (not on it) — a legitimate short move from spawn
  const nx = tx, ny = ty - 1;
  c.send({ t: 'move', x: nx, y: ny });
  await c.waitPosChange(3000).catch(() => {});
  await sleep(150);
  const beforeWall = c.pos();
  ok(!!beforeWall, 'C has an authoritative server position before touching the wall', beforeWall);

  c.send({ t: 'move', x: tx, y: ty });                     // straight onto the walled tile
  const afterWallMsg = await c.waitPosChange(3000).catch(() => null);
  const afterWall = afterWallMsg ? { x: afterWallMsg.you[0], y: afterWallMsg.you[1] } : c.pos();
  ok(!!afterWall && !(afterWall.x === tx && afterWall.y === ty),
    'the server never placed C on the walled tile, even though it asked to move there', { beforeWall, afterWall, wall: { tx, ty } });

  section('POSITIVE CONTROL — a normal move to a free neighbouring tile still works (the handler is not just dead)');
  const freeX = tx + 1, freeY = ty - 1;                    // diagonal from C's current spot, off the wall
  c.send({ t: 'move', x: freeX, y: freeY });
  const freeMsg = await c.waitPosChange(3000).catch(() => null);
  const afterFree = freeMsg ? { x: freeMsg.you[0], y: freeMsg.you[1] } : c.pos();
  ok(!!afterFree && Math.abs(afterFree.x - freeX) < 0.6 && Math.abs(afterFree.y - freeY) < 0.6,
    'C moved onto the free neighbouring tile normally', { afterFree, freeX, freeY });

  section('REMOVAL — the owner tears the wall down through release-structure, no refund, same verb release() uses for tiles');
  const nonOwner = new Client('D', port);
  await nonOwner.connect();
  nonOwner.send({ t: 'hello', key: 'wall-key-DDDD-0004', name: 'SNOOP' });
  await nonOwner.waitFor(m => m.t === 'welcome');
  nonOwner.send({ t: 'release-structure', x: tx, y: ty });
  const stolen = await nonOwner.waitNew(m => m.t === 'structure-released', 4000);
  ok(stolen && stolen.err === 'not yours', 'a non-owner cannot release someone else\'s wall', stolen);
  nonOwner.close();

  // a bystander already subscribed to the wall's chunk must see it vanish live
  const bLive = new Client('LIVE', port);
  await bLive.connect();
  bLive.send({ t: 'hello', key: 'wall-key-EEEE-0005', name: 'NEIGHBOUR' });
  await bLive.waitFor(m => m.t === 'welcome');
  bLive.send({ t: 'view', x: tx, y: ty });
  // the initial join sends a whole grid of chunks (not just the wall's one) — wait for
  // THAT specific chunk, not just any chunk message, before checking what it carried.
  const wcx = T.chunkOf(tx), wcy = T.chunkOf(ty);
  await bLive.waitFor(m => m.t === 'chunk' && m.map === map && m.cx === wcx && m.cy === wcy, 6000).catch(() => {});
  ok(!!bLive.structs.get(tx + ',' + ty), 'the bystander sees the wall via ordinary chunk delivery first', bLive.structs.get(tx + ',' + ty));

  a.send({ t: 'release-structure', x: tx, y: ty });
  const released = await a.waitNew(m => m.t === 'structure-released', 4000);
  ok(released && !released.err && released.kind === 'wall', 'the owner released their own wall', released);

  const gone = await bLive.waitFor(m => m.t === 'structure-gone' && m.x === tx && m.y === ty, 4000).catch(() => null);
  ok(!!gone, 'the bystander got a live structure-gone broadcast the instant it was torn down', gone);
  ok(!bLive.structs.has(tx + ',' + ty), 'and it is gone from the bystander\'s own structure map', [...bLive.structs.keys()]);
  bLive.close();

  section('CLEARED — once the wall is gone, the tile is walkable again');
  // C should currently be sitting at freeX,freeY (adjacent) — walk it onto the now-clear tile
  c.send({ t: 'move', x: tx, y: ty });
  const clearedMsg = await c.waitPosChange(3000).catch(() => null);
  const afterClear = clearedMsg ? { x: clearedMsg.you[0], y: clearedMsg.you[1] } : c.pos();
  ok(!!afterClear && Math.abs(afterClear.x - tx) < 0.6 && Math.abs(afterClear.y - ty) < 0.6,
    'with the wall gone, the same tile is now walkable', { afterClear, tx, ty });
  c.close();

  a.send({ t: 'release-structure', x: tx, y: ty });
  const doubleRelease = await a.waitNew(m => m.t === 'structure-released', 4000);
  ok(doubleRelease && doubleRelease.err === 'no structure there', 'releasing an already-gone wall is refused cleanly, not silently', doubleRelease);

  section('THE SERVER SURVIVED THE WHOLE SUITE');
  ok(mustLive() && srv.exited === null, 'the server never crashed', srv.exited);

  a.close();
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exited === null) { try { srv.kill('SIGKILL'); } catch (e) {} }
  console.log('\n' + (fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED — ${pass} passed`) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
