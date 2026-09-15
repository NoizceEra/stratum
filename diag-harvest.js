/**
 * diag-harvest.js — throwaway diagnostic. Why does test-restart's node depletion fail?
 * Starts a real server (fresh DB, REAL respawn clocks), walks to the nearest alive node
 * on map 2 and prints EVERY raw harvest response.
 */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const DB = path.join(CWD, 'data', 'diag.db');
const PORT = 8123;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch (e) {} }

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class C {
  constructor() { this.msgs = []; this.nodes = []; this.raw = []; }
  connect() {
    return new Promise((res, rej) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
      req.on('upgrade', (r, s) => { this.sock = s; this.buf = Buffer.alloc(0); s.on('data', d => this._feed(d)); res(); });
      req.on('error', rej); req.end();
    });
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const t = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      let m; try { m = JSON.parse(t); } catch (e) { continue; }
      if (m.t === 'chunk' && m.nodes) for (const n of m.nodes) this.nodes.push({ x: n[0], y: n[1], kind: n[2], state: n[3] });
      this.msgs.push(m);
      if (m.t === 'harvested' || m.t === 'you') this.raw.push(m);
    }
  }
  send(o) {
    const p = Buffer.from(JSON.stringify(o));
    const mk = crypto.randomBytes(4);
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    this.sock.write(Buffer.concat([h, mk, Buffer.from(p.map((b, i) => b ^ mk[i & 3]))]));
  }
  wait(test, ms) {
    const hit = this.msgs.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => { const iv = setInterval(() => { const h = this.msgs.find(test); if (h) { clearInterval(iv); res(h); } }, 50); setTimeout(() => clearInterval(iv), ms || 6000); });
  }
  pos() { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'players' && this.msgs[i].you) return { x: this.msgs[i].you[0], y: this.msgs[i].you[1] }; return null; }
  async approach(tx, ty, within, budget) {
    const t0 = Date.now(); let d = Infinity;
    while (Date.now() - t0 < (budget || 25000)) {
      const p = this.pos(); if (!p) { await sleep(120); continue; }
      d = Math.hypot(tx - p.x, ty - p.y); if (d <= within) return d;
      const s = Math.min(1.5, d);
      this.send({ t: 'move', x: Math.round(p.x + ((tx - p.x) / d) * s), y: Math.round(p.y + ((ty - p.y) / d) * s) });
      await sleep(140);
    }
    return d;
  }
}

function startServer() {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD, env: { ...process.env, PORT: String(PORT), STRATUM_DB: DB }, stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv:ERR] ' + d));
  return srv;
}
function waitReady() {
  return new Promise((resolve, reject) => {
    let t = 0;
    const tick = () => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stats' }, res => { res.resume(); resolve(); }); r.on('error', () => { if (++t > 90) return reject(new Error('no server')); setTimeout(tick, 150); }); };
    tick();
  });
}

(async function () {
  const srv = startServer();
  await waitReady();
  const c = new C();
  await c.connect();
  c.send({ t: 'hello', key: 'diag-key-1', name: 'DIAG' });
  const w = await c.wait(m => m.t === 'welcome');
  console.log('\n--- spawn map0', JSON.stringify(w.spawn));
  c.send({ t: 'travel', map: 2 });
  const arr = await c.wait(m => m.t === 'arrived', 8000);
  console.log('--- arrived map', arr.map, arr.name, 'spawn', JSON.stringify(arr.spawn));
  await sleep(800);
  const alive = c.nodes.filter(n => n.state === 1);
  const p = c.pos();
  console.log('--- streamed nodes total', c.nodes.length, 'alive', alive.length, 'my pos', JSON.stringify(p));
  const kinds = {};
  for (const n of c.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  console.log('--- node kinds in stream', JSON.stringify(kinds));
  alive.sort((u, v) => Math.hypot(u.x - p.x, u.y - p.y) - Math.hypot(v.x - p.x, v.y - p.y));
  const node = alive[0];
  console.log('--- target node', JSON.stringify(node), 'dist', Math.round(Math.hypot(node.x - p.x, node.y - p.y)));
  const d = await c.approach(node.x, node.y, 3, 25000);
  const p2 = c.pos();
  console.log('--- approached to', Math.round(d), 'pos now', JSON.stringify(p2), 'dx,dy', node.x - p2.x, node.y - p2.y);
  for (let i = 0; i < 10; i++) {
    c.raw.length = 0;
    c.send({ t: 'harvest', x: node.x, y: node.y });
    await sleep(900);
    console.log('  harvest#' + (i + 1) + ' ->', JSON.stringify(c.raw.filter(m => m.t === 'harvested')));
    if (c.raw.some(m => m.t === 'harvested' && m.state === 0)) { console.log('  DEPLETED on attempt', i + 1); break; }
  }
  const st = await new Promise(res => http.get('http://127.0.0.1:' + PORT + '/api/stats', r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }));
  console.log('--- /api/stats', st);
  srv.kill();
  process.exit(0);
})();
