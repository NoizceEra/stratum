/**
 * STRATUM protocol test — drives real WebSocket clients against a live server and
 * asserts the world rules actually hold. No test framework, no dependencies.
 *
 * Covers both layers:
 *   PERSISTENT  land ownership, reach, bounds, per-map isolation
 *   VOLATILE    resource harvest, node reset, monster kill, monster reset
 *
 *   node test.js      (expects a server on PORT, default 8091)
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PORT = Number(process.env.PORT || 8091);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }

class Client {
  constructor(tag) { this.tag = tag; this.msgs = []; this.waiters = []; this.chunks = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) return reject(new Error('bad accept key'));
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
      if (m.t === 'chunk' && m.nodes) for (const n of m.nodes) this.chunks.push({ map: m.map, x: n[0], y: n[1], kind: n[2], state: n[3], ripe: n[4] });
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
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout')); }, ms || 3000);
    });
  }
  /** Wait for a message that arrives AFTER this call — stale matches don't count. */
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
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout(new)')); }, ms || 3000);
    });
  }
  /** Latest known server-authoritative position for this client. */
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'players' && m.you) return { x: m.you[0], y: m.you[1] };
    }
    return null;
  }
  /**
   * Walk toward a tile in INCREMENTS. The server rejects any single move larger than
   * ~14 tiles/s, so repeatedly asking to teleport to the destination never moves you.
   */
  async approach(tx, ty, within, budgetMs) {
    const t0 = Date.now();
    let d = Infinity;
    while (Date.now() - t0 < (budgetMs || 20000)) {
      const p = this.pos();
      if (!p) { await sleep(120); continue; }
      const dx = tx - p.x, dy = ty - p.y;
      d = Math.hypot(dx, dy);
      if (d <= within) return d;
      const step = Math.min(1.5, d);
      this.send({ t: 'move', x: Math.round(p.x + (dx / d) * step), y: Math.round(p.y + (dy / d) * step) });
      await sleep(140);
    }
    return d;
  }
  /** Walk to the nearest creature and strike it. Returns the kill message or null. */
  async hunt(budgetMs) {
    const t0 = Date.now();
    let kill = null;
    while (Date.now() - t0 < (budgetMs || 25000) && !kill) {
      const p = this.pos();
      const list = this.monsters();
      if (!p || !list.length) { await sleep(140); continue; }
      let best = null, bd = 1e9;
      for (const m of list) {
        const d = Math.hypot(m[2] - p.x, m[3] - p.y);
        if (d < bd) { bd = d; best = m; }
      }
      if (!best) { await sleep(140); continue; }
      if (bd <= 4) {
        this.send({ t: 'attack', id: best[0] });
        try {
          const r = await this.waitNew(m => m.t === 'combat' && m.id === best[0], 1500);
          if (r.killed) kill = r;
        } catch (e) {}
        await sleep(100);
      } else {
        const dx = best[2] - p.x, dy = best[3] - p.y;
        const step = Math.min(1.5, bd);
        this.send({ t: 'move', x: Math.round(p.x + (dx / bd) * step), y: Math.round(p.y + (dy / bd) * step) });
        await sleep(140);
      }
    }
    return kill;
  }
  monsters() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'mons') return m.list;
    }
    return [];
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function stats() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + PORT + '/api/stats', (res) => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async function main() {
  console.log('\nSTRATUM protocol test — live server\n');

  const a = new Client('A'), b = new Client('B');
  await a.connect(); await b.connect();

  section('CONNECTION');
  ok(true, 'two clients completed the WebSocket handshake');

  a.send({ t: 'hello', key: 'test-key-AAAA-0001', name: 'ALPHA' });
  const wa = await a.waitFor(m => m.t === 'welcome');
  ok(wa.name === 'ALPHA' && wa.world.w === 1024, 'A got welcome with a 1024x1024 world', wa.world);
  ok(wa.reach === 6 && wa.attackRange === 3, 'A told reach 6 and attack range 3', [wa.reach, wa.attackRange]);
  ok(Array.isArray(wa.maps) && wa.maps.length === 3, 'A told there are 3 maps', wa.maps && wa.maps.length);
  const sp = wa.spawn;

  b.send({ t: 'hello', key: 'test-key-BBBB-0002', name: 'BETA' });
  const wb = await b.waitFor(m => m.t === 'welcome');
  ok(wb.name === 'BETA', 'B got welcome');

  section('PERSISTENT LAYER — land is owned absolutely');
  b.send({ t: 'set', x: sp.x + 2, y: sp.y, m: 7 });
  const you1 = await b.waitFor(m => m.t === 'you' || m.t === 'deny');
  ok(you1.t === 'you' && you1.m === 7, 'B claimed an unclaimed tile in the commons (brick)', you1);

  const seen = await a.waitFor(m => m.t === 'tiles' && m.list[0][0] === sp.x + 2, 3000);
  ok(seen.list[0][2] === 7, "A received B's tile over the wire (live sync)", seen.list[0]);

  a.send({ t: 'set', x: sp.x + 2, y: sp.y, m: 3 });
  const deny1 = await a.waitFor(m => m.t === 'deny' && m.x === sp.x + 2);
  ok(deny1.r === 'owned', "A DENIED overwriting B's tile — ownership is absolute", deny1);

  a.send({ t: 'set', x: sp.x + 40, y: sp.y, m: 3 });
  ok((await a.waitFor(m => m.t === 'deny' && m.x === sp.x + 40)).r === 'reach', 'A DENIED building 40 tiles away');

  a.send({ t: 'set', x: -5, y: 10, m: 3 });
  ok((await a.waitFor(m => m.t === 'deny' && m.r === 'bounds')).r === 'bounds', 'A DENIED building outside the world');

  a.send({ t: 'set', x: sp.x, y: sp.y, m: 999 });
  ok((await a.waitFor(m => m.t === 'deny' && m.x === sp.x && m.y === sp.y)).r === 'material', 'A DENIED a non-placeable material');

  b.send({ t: 'set', x: sp.x + 2, y: sp.y, m: 0 });
  const un = await b.waitFor(m => m.t === 'unclaim');
  ok(un.x === sp.x + 2, 'B returned its own tile to the commons', un);
  await a.waitFor(m => m.t === 'tiles' && m.list[0][2] === -1 && m.list[0][0] === sp.x + 2, 3000);

  section('MULTIPLE MAPS — and the land does NOT leak between them');
  a.send({ t: 'set', x: sp.x + 1, y: sp.y + 1, m: 3 });
  const onM0 = await a.waitFor(m => m.t === 'you' && m.x === sp.x + 1 && m.y === sp.y + 1);
  ok(onM0.claimed === 1, 'map 0 now holds exactly 1 claimed tile', onM0.claimed);

  a.send({ t: 'travel', map: 1 });
  const arr = await a.waitFor(m => m.t === 'arrived', 5000);
  ok(arr.map === 1 && arr.name === 'ASHEN HOLLOW', 'A travelled to map 1 ASHEN HOLLOW', { map: arr.map, name: arr.name });
  ok(arr.claimed === 0, 'map 1 starts with 0 claimed tiles — claims are per-map', arr.claimed);

  await sleep(300);
  const sp1 = arr.spawn;
  a.send({ t: 'set', x: sp1.x + 1, y: sp1.y + 1, m: 7 });
  const onM1 = await a.waitFor(m => m.t === 'you' && m.x === sp1.x + 1);
  ok(onM1.claimed === 1, 'map 1 now holds exactly 1 claimed tile (same coords as map 0)', onM1.claimed);

  a.send({ t: 'travel', map: 0 });
  const back = await a.waitFor(m => m.t === 'arrived' && m.map === 0, 5000);
  ok(back.claimed === 1, 'back on map 0 the claim count is still 1 — the maps are isolated', back.claimed);

  const s1 = await stats();
  ok(s1.maps['0'].claimed === 1 && s1.maps['1'].claimed === 1, 'stats API reports claims per map independently', s1.maps);

  section('VOLATILE LAYER — resource nodes harvest and reset');
  await sleep(400);                       // let the post-travel position settle
  const live = a.chunks.filter(n => n.map === 0 && n.state === 1);
  ok(live.length > 0, 'A was sent live resource nodes with its chunks', live.length);
  const KINDNAME = { 1: 'TREE', 2: 'ORE', 3: 'HERB', 4: 'CRYSTAL' };
  ok(new Set(live.map(n => n.kind)).size > 1, 'the world generated more than one kind of node',
    [...new Set(live.map(n => n.kind))].map(k => KINDNAME[k]));

  // pick the nearest node to where the server says we actually are, and stay close enough
  // to walk to it (all respawn timers are scaled down for the test)
  const p0 = a.pos();
  ok(!!p0, 'A knows its own server-side position', p0);
  live.sort((u, v) => Math.hypot(u.x - p0.x, u.y - p0.y) - Math.hypot(v.x - p0.x, v.y - p0.y));
  const node = live[0];
  const nodeDist = Math.hypot(node.x - p0.x, node.y - p0.y);
  ok(nodeDist < 60, 'chose the nearest node: ' + KINDNAME[node.kind] + ' at ' + node.x + ',' + node.y +
    ' (' + Math.round(nodeDist) + ' tiles away)', { kind: node.kind, dist: Math.round(nodeDist) });

  const d = await a.approach(node.x, node.y, 3, 25000);
  const pAfter = a.pos();
  ok(d <= 3, 'A walked to the node — server now reports ' + Math.round(Math.hypot(pAfter.x - node.x, pAfter.y - node.y)) + ' tiles away',
    Math.round(d));

  let yieldMsg = null, lastReply = null;
  for (let i = 0; i < 8 && !yieldMsg; i++) {
    a.send({ t: 'harvest', x: node.x, y: node.y });
    const r = await a.waitNew(m => m.t === 'harvested' && m.x === node.x && m.y === node.y, 2500);
    lastReply = r;
    if (r.state === 0) yieldMsg = r; else await sleep(120);
  }
  ok(yieldMsg && yieldMsg.ripeSec > 0, 'node exhausted: depleted with a reset timer',
    yieldMsg ? { state: yieldMsg.state, ripeSec: yieldMsg.ripeSec } : lastReply);
  ok(yieldMsg && yieldMsg.gains && Object.keys(yieldMsg.gains).length >= 1 && Object.values(yieldMsg.gains).every(v => v > 0), 'A was credited with the resource (+ dual commerce rewards)', yieldMsg && yieldMsg.gains);
  ok(yieldMsg && yieldMsg.inv && Object.values(yieldMsg.inv).some(v => v > 0), 'inventory updated', yieldMsg && yieldMsg.inv);

  a.send({ t: 'harvest', x: node.x, y: node.y });
  const again = await a.waitNew(m => m.t === 'harvested' && m.err, 2500);
  ok(again.err === 'still regrowing', 'a depleted node cannot be harvested again', again.err);

  const revived = await a.waitNew(m => m.t === 'node' && m.x === node.x && m.y === node.y && m.state === 1, 12000);
  ok(revived.state === 1, 'THE NODE RESET — it came back on its own timer', { x: revived.x, y: revived.y });

  section('VOLATILE LAYER — monsters fight and reset');
  // Click-to-strike only works on Frontier maps: the cozy pivot made map 0 (where A just
  // travelled back to, above) Sanctuary, so creatures there use ambient combat instead
  // and 'attack' is refused. Hop to map 1 (Frontier) for this section.
  a.send({ t: 'travel', map: 1 });
  await a.waitNew(m => m.t === 'arrived' && m.map === 1, 5000);
  await sleep(400);                       // let the post-travel position/mons settle
  ok(a.monsters().length > 0, 'A is being told about nearby creatures', a.monsters().length);
  const killed = await a.hunt(30000);
  ok(killed && killed.killed === true, 'A slew a creature', killed && killed.name);
  ok(killed && killed.kills === 1, 'kill counted', killed && killed.kills);
  ok(killed && killed.inv && Object.values(killed.inv).some(v => v > 0), 'loot collected', killed && killed.inv);

  const respawn = await a.waitNew(m => m.t === 'mon' && m.id === (killed ? killed.id : -1) && m.spawn, 12000);
  ok(respawn.spawn === true, 'THE CREATURE RESET — it respawned at its home', { id: respawn.id, x: respawn.x, y: respawn.y });

  const s2 = await stats();
  ok(s2.volatile.monstersKnown > 0, 'stats API reports the volatile layer', s2.volatile);

  section('WORLD MAP ARTIFACT');
  a.send({ t: 'map' });
  const mp = await a.waitFor(m => m.t === 'map');
  ok(mp.grid === 256 && mp.d.length > 0, 'per-map claim grid delivered (' + mp.grid + 'x' + mp.grid + ')');

  a.close(); b.close();
  await sleep(300);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nTEST HARNESS ERROR:', e.stack || e.message, '\n'); process.exit(2); });
