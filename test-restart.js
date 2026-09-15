/**
 * test-restart.js — proves the two-layer promise survives a server restart.
 *
 *   node test-restart.js setup    (fresh DB: claim land, deplete a node, record state)
 *   <kill the server>
 *   node test-restart.js verify   (same DB: land must still be there, node must still be regrowing)
 *
 * Uses the REAL respawn timers (no scaling) so "still regrowing" is a meaningful claim.
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8092);
const PHASE = process.argv[2];
const STATE = path.join(__dirname, 'data', 'restart-state.json');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}

class C {
  constructor() { this.msgs = []; this.nodes = []; this.waiters = []; }
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
      if (this.buf.length < off + len) return;
      const t = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      let m; try { m = JSON.parse(t); } catch (e) { continue; }
      if (m.t === 'chunk' && m.nodes) for (const n of m.nodes) this.nodes.push({ map: m.map, x: n[0], y: n[1], kind: n[2], state: n[3] });
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => { if (w.test(m)) { w.resolve(m); return false; } return true; });
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
    return new Promise((res, rej) => {
      const w = { test, resolve: res };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error('timeout')); }, ms || 4000);
    });
  }
  waitNew(test, ms) {
    const from = this.msgs.length;
    const scan = () => { for (let i = from; i < this.msgs.length; i++) if (test(this.msgs[i])) return this.msgs[i]; return null; };
    const hit = scan();
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { test: () => { const r = scan(); if (r) { w.resolve(r); return true; } return false; }, resolve: res };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); rej(new Error('timeout(new)')); }, ms || 4000);
    });
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

function stats() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:' + PORT + '/api/stats', r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(JSON.parse(s))); }).on('error', rej);
  });
}

(async function () {
  const c = new C();
  await c.connect();

  if (PHASE === 'setup') {
    console.log('\nSETUP — claim land on two maps and deplete one node\n');
    c.send({ t: 'hello', key: 'restart-key-0001', name: 'PERSIST' });
    const w = await c.wait(m => m.t === 'welcome');
    const sp0 = w.spawn;

    c.send({ t: 'set', x: sp0.x + 3, y: sp0.y + 2, m: 7 });
    await c.waitNew(m => m.t === 'you', 4000);
    c.send({ t: 'set', x: sp0.x + 4, y: sp0.y + 2, m: 8 });
    const y2 = await c.waitNew(m => m.t === 'you' && m.x === sp0.x + 4, 4000);
    ok(y2.claimed === 2, 'claimed 2 tiles on map 0', y2.claimed);

    c.send({ t: 'travel', map: 2 });
    const arr = await c.waitNew(m => m.t === 'arrived', 6000);
    ok(arr.map === 2, 'travelled to map 2 ' + arr.name, arr.name);
    await sleep(600);
    c.send({ t: 'set', x: arr.spawn.x + 2, y: arr.spawn.y + 2, m: 3 });
    const y3 = await c.waitNew(m => m.t === 'you', 4000);
    ok(y3.claimed === 1, 'claimed 1 tile on map 2', y3.claimed);

    // deplete a node — REAL timer, so it must still be regrowing after the restart
    await sleep(400);
    // Nodes must be filtered by MAP: the socket keeps streaming chunks from every map the
    // player has stood on, and (513,521) is a different tile on each one. Harvesting a
    // tile that is a node on map 0 while standing on map 2 is refused with "no node here".
    const alive = c.nodes.filter(n => n.state === 1 && n.map === 2);
    const p = c.pos();
    alive.sort((u, v) => Math.hypot(u.x - p.x, u.y - p.y) - Math.hypot(v.x - p.x, v.y - p.y));
    const node = alive[0];
    const d = await c.approach(node.x, node.y, 3, 25000);
    ok(d <= 3, 'walked to the node at ' + node.x + ',' + node.y, Math.round(d));

    let depleted = null;
    for (let i = 0; i < 8 && !depleted; i++) {
      c.send({ t: 'harvest', x: node.x, y: node.y });
      const r = await c.waitNew(m => m.t === 'harvested' && m.x === node.x && m.y === node.y, 2500);
      if (r.state === 0) depleted = r; else await sleep(120);
    }
    ok(!!depleted, 'node depleted with a REAL timer of ' + (depleted ? depleted.ripeSec : '?') + 's');
    ok(depleted && depleted.ripeSec >= 20, 'the timer is long enough to survive a restart', depleted && depleted.ripeSec);

    const st = await stats();
    const state = {
      claimed: { 0: st.maps['0'].claimed, 2: st.maps['2'].claimed },
      node: { map: 2, x: node.x, y: node.y, kind: node.kind, ripeSec: depleted.ripeSec }
    };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    console.log('  recorded:', JSON.stringify(state));
    console.log('\n' + (fail === 0 ? 'SETUP OK' : 'SETUP FAILED') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
  }

  if (PHASE === 'verify') {
    console.log('\nVERIFY — after restart, the land must be intact and the node still regrowing\n');
    const want = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const st = await stats();

    ok(st.maps['0'].claimed === want.claimed['0'], 'map 0 still reports ' + want.claimed['0'] + ' claimed tiles', st.maps['0']);
    ok(st.maps['2'].claimed === want.claimed['2'], 'map 2 still reports ' + want.claimed['2'] + ' claimed tiles', st.maps['2']);
    ok(st.volatile.nodesDepleted >= 1, 'the depleted node is loaded as still regrowing (not silently refilled)', st.volatile);

    // the player got their state back too
    c.send({ t: 'hello', key: 'restart-key-0001', name: 'PERSIST' });
    const w = await c.wait(m => m.t === 'welcome', 5000);
    ok(w.map === want.node.map, 'player returned to map ' + w.map + ' where they logged off', w.map);

    // travel back and confirm the node is STILL depleted
    c.send({ t: 'travel', map: want.node.map });
    await c.waitNew(m => m.t === 'arrived', 6000);
    await sleep(600);
    const seen = c.nodes.filter(n => n.map === want.node.map && n.x === want.node.x && n.y === want.node.y)[0];
    ok(seen && seen.state === 0, 'the node is delivered to the client as DEPLETED', seen);
    if (seen) {
      const left = Math.max(0, seen.ripe !== undefined ? seen.ripe : 0);
      console.log('        (still waiting on that tile)');
    }

    await c.approach(want.node.x, want.node.y, 4, 25000);
    c.send({ t: 'harvest', x: want.node.x, y: want.node.y });
    const r = await c.waitNew(m => m.t === 'harvested', 3000);
    ok(r.err === 'still regrowing', 'harvesting it is refused: still regrowing', r.err);

    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail === 0 ? 0 : 1);
  }

  console.error('usage: node test-restart.js setup|verify');
  process.exit(2);
})().catch(e => { console.error('\nHARNESS ERROR:', e.message, '\n'); process.exit(2); });
