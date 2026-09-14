/**
 * probe.js — focused diagnostic for the harvest reach failure.
 * Spawns its own server, connects one client, walks to the nearest node and reports
 * exactly what the server says, including any damage/death along the way.
 *
 *   node probe.js
 */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8093, CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'probe.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TESTDB + s); } catch (e) {} }

const srv = spawn(process.execPath, ['server.js'], {
  cwd: CWD, env: { ...process.env, PORT: String(PORT), STRATUM_DB: TESTDB, STRATUM_RESPAWN_SCALE: '0.02' },
  stdio: ['ignore', 'pipe', 'pipe']
});
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const msgs = [], nodes = [], events = [];

function connect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (res, socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', d => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          const b1 = buf[1];
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) return;
          const txt = buf.subarray(off, off + len).toString('utf8');
          buf = buf.subarray(off + len);
          let m; try { m = JSON.parse(txt); } catch (e) { continue; }
          msgs.push(m);
          if (m.t === 'chunk' && m.nodes) for (const n of m.nodes) nodes.push({ map: m.map, x: n[0], y: n[1], kind: n[2], state: n[3] });
          if (m.t === 'dmg' || m.t === 'died' || m.t === 'harvested' || m.t === 'deny') events.push(m);
        }
      });
      global.SOCK = socket;
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
}
function send(o) {
  const p = Buffer.from(JSON.stringify(o));
  const mask = crypto.randomBytes(4);
  let head;
  if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  global.SOCK.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i & 3]))]));
}
function pos() {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === 'players' && msgs[i].you) return { x: msgs[i].you[0], y: msgs[i].you[1] };
  return null;
}
function lastHarvested() {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].t === 'harvested') return events[i];
  return null;
}

(async function () {
  let tries = 0;
  while (tries++ < 80) {
    try { await new Promise((res, rej) => { http.get({ host: '127.0.0.1', port: PORT, path: '/api/stats' }, r => { r.resume(); res(); }).on('error', rej); }); break; }
    catch (e) { await sleep(150); }
  }
  await connect();
  send({ t: 'hello', key: 'probe-key-0001', name: 'PROBE' });
  await sleep(800);

  const hello = msgs.find(m => m.t === 'welcome');
  console.log('\nspawn per welcome:', hello.spawn, ' map', hello.map, ' x,y', hello.x, hello.y);
  console.log('server position now:', pos());
  console.log('chunk messages:', msgs.filter(m => m.t === 'chunk').length, ' nodes seen:', nodes.length);

  const me = pos();
  const dist = n => Math.hypot(n.x - me.x, n.y - me.y);
  const near = nodes.slice().sort((u, v) => dist(u) - dist(v)).slice(0, 5);
  console.log('\n5 nearest nodes to the server-known position:');
  near.forEach(n => console.log('   map', n.map, 'at', n.x + ',' + n.y, 'kind', n.kind, 'state', n.state, 'dist', dist(n).toFixed(1)));

  const t = near[0];
  console.log('\nwalking to', t.x + ',' + t.y, '...');
  const t0 = Date.now();
  let d = 999, iters = 0;
  while (Date.now() - t0 < 25000) {
    const p = pos();
    if (!p) { await sleep(120); continue; }
    d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d <= 3) break;
    const step = Math.min(1.5, d);
    send({ t: 'move', x: Math.round(p.x + ((t.x - p.x) / d) * step), y: Math.round(p.y + ((t.y - p.y) / d) * step) });
    iters++;
    if (iters % 20 === 0) console.log('   step', iters, 'server pos', pos(), 'dist', d.toFixed(1));
    await sleep(140);
  }
  console.log('   walk finished. iterations', iters, ' server pos', pos(), ' dist', d.toFixed(2));

  console.log('\ndamage/death events during walk:', JSON.stringify(events.filter(e => e.t === 'dmg' || e.t === 'died')));

  send({ t: 'harvest', x: t.x, y: t.y });
  await sleep(700);
  console.log('harvest response:', JSON.stringify(lastHarvested()));
  console.log('server pos after harvest:', pos());

  srv.kill();
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
