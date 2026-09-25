/**
 * founder-bot.js — a real STRATUM colonist that plays the game.
 *
 * This is a WebSocket client, same protocol as /play. Other players see a named
 * avatar, a claimed homestead, idle structures, and (once tamed) a companion.
 *
 * NEVER links a wallet. NEVER uses STRATUM_CLAIM_SIGNER_KEY / the treasury.
 * Play does not need a wallet. One wallet is one colonist — binding the treasury
 * to this key would lock payouts to the bot.
 *
 *   node scripts/founder-bot.js                  # loop on :8090
 *   node scripts/founder-bot.js --once           # homestead pass, then idle ~2 min and exit
 *   set STRATUM_FOUNDER_URL=https://planetstratum.fun
 *   set STRATUM_FOUNDER_NAME=WARDEN
 *   set STRATUM_FOUNDER_PARCEL=WARDEN ACRE
 *
 * Key + plot persist in data/founder.key and data/founder-state.json (gitignored
 * with the rest of data/).
 */
'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../public/terrain.js');

const ROOT = path.join(__dirname, '..');
const KEYFILE = path.join(ROOT, 'data', 'founder.key');
const STATEFILE = path.join(ROOT, 'data', 'founder-state.json');

const NAME = (process.env.STRATUM_FOUNDER_NAME || 'WARDEN').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 18) || 'WARDEN';
const PARCEL = (process.env.STRATUM_FOUNDER_PARCEL || (NAME + ' ACRE')).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 24);
const PALETTE = process.env.STRATUM_FOUNDER_PALETTE || 'moss';
const BASE = process.env.STRATUM_FOUNDER_URL || 'http://127.0.0.1:8090';
const ONCE = process.argv.includes('--once') || process.env.STRATUM_FOUNDER_ONCE === '1';
const PLOT = Math.max(3, Math.min(9, (process.env.STRATUM_FOUNDER_PLOT | 0) || 5));
const REACH = 6;
const SPAWN_KEEP = 14;
const ID = T.ID;

function log() { console.log.apply(console, ['[founder]'].concat([].slice.call(arguments))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(lo, hi) { return lo + Math.random() * (hi - lo); }
function hypot(ax, ay, bx, by) { return Math.hypot((ax || 0) - (bx || 0), (ay || 0) - (by || 0)); }

function loadKey() {
  try {
    const k = fs.readFileSync(KEYFILE, 'utf8').trim();
    if (k && /^[\x21-\x7e]{8,64}$/.test(k)) return k;
  } catch (e) {}
  const k = 'founder-' + crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(KEYFILE), { recursive: true });
  fs.writeFileSync(KEYFILE, k + '\n', { encoding: 'utf8', mode: 0o600 });
  log('wrote new player key', KEYFILE);
  return k;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  fs.mkdirSync(path.dirname(STATEFILE), { recursive: true });
  fs.writeFileSync(STATEFILE, JSON.stringify(st, null, 2));
}

function parseUrl(u) {
  const x = new URL(u);
  const tls = x.protocol === 'https:' || x.protocol === 'wss:';
  return { tls, host: x.hostname, port: +(x.port || (tls ? 443 : 80)), path: x.pathname === '/' || !x.pathname ? '/' : x.pathname };
}

class Client {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.x = 0; this.y = 0; this.map = 0;
    this.inv = {}; this.energy = 240; this.key = '';
    this.pet = null; this.spawn = null;
    this.edits = new Map();
    this.nodes = new Map();
    this.mons = [];
    this.structures = new Map();
    this.players = [];
    this.ready = false;
  }
  connect(target) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const lib = target.tls ? https : http;
      const req = lib.request({
        host: target.host, port: target.port, path: target.path,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', (d) => this._feed(d));
        socket.on('error', (e) => log('socket', e.message));
        socket.on('close', () => { this.ready = false; });
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
      const b0 = this.buf[0], b1 = this.buf[1];
      const op = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (op !== 1) continue;
      let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      this._ingest(m);
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => { if (w.test(m)) { w.resolve(m); return false; } return true; });
    }
  }
  _ingest(m) {
    if (!m || !m.t) return;
    if (m.t === 'welcome' || m.t === 'arrived') {
      this.x = m.x; this.y = m.y; this.map = m.map | 0;
      if (m.inv) this.inv = m.inv;
      if (typeof m.energy === 'number') this.energy = m.energy;
      if (m.pet) this.pet = m.pet;
      if (m.spawn) this.spawn = m.spawn;
      if (m.key) this.key = m.key;
      this.ready = true;
    }
    if (m.t === 'you') {
      if (typeof m.energy === 'number') this.energy = m.energy;
      if (m.inv) this.inv = m.inv;
      if (typeof m.x === 'number') this.edits.set(m.x + ',' + m.y, { m: m.m, owner: this.key });
    }
    if (m.t === 'harvested' && m.inv) this.inv = m.inv;
    if (m.t === 'collected' && m.inv) this.inv = m.inv;
    if (m.t === 'built' && m.inv) this.inv = m.inv;
    if (m.t === 'pet') {
      if (m.inv) this.inv = m.inv;
      this.pet = m.pet || m;
    }
    if (m.t === 'vitals') {
      if (m.inv) this.inv = m.inv;
      if (typeof m.energy === 'number') this.energy = m.energy;
      if (m.pet) this.pet = m.pet;
    }
    if (m.t === 'chunk' && m.map === this.map) {
      const buf = Buffer.from(m.d, 'base64');
      for (let i = 0; i + 3 < buf.length; i += 4) {
        const x = m.cx * T.CHUNK + buf[i], y = m.cy * T.CHUNK + buf[i + 1];
        this.edits.set(x + ',' + y, { m: buf[i + 2], owner: m.owners[buf[i + 3]] });
      }
      if (m.nodes) for (const n of m.nodes) this._node(n);
      if (m.structures) for (const s of m.structures) this.structures.set(s.x + ',' + s.y, s);
    }
    if (m.t === 'tiles' && m.list) {
      for (const l of m.list) {
        const k = l[0] + ',' + l[1];
        if (l[2] === -1) this.edits.delete(k);
        else this.edits.set(k, { m: l[2], owner: l[3] });
      }
    }
    if (m.t === 'node') this._node([m.x, m.y, m.kind, m.state, m.ripeSec]);
    if (m.t === 'structure') this.structures.set(m.x + ',' + m.y, m);
    if (m.t === 'structure-gone') this.structures.delete(m.x + ',' + m.y);
    if (m.t === 'mons' && m.list) this.mons = m.list;
    if (m.t === 'players' && m.list) {
      this.players = m.list;
      if (m.you) { this.x = m.you[0]; this.y = m.you[1]; if (m.you[2] != null) this.energy = m.you[2]; }
    }
  }
  _node(a) {
    if (!a || a.length < 4) return;
    this.nodes.set(a[0] + ',' + a[1], { x: a[0], y: a[1], kind: a[2], state: a[3], ripeSec: a[4] || 0 });
  }
  send(o) {
    if (!this.socket || this.socket.destroyed) return;
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
      setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error('timeout'));
      }, ms || 8000);
    });
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

function dry(map, x, y) {
  const b = T.baseTypeFor(map, x, y);
  return b !== ID.WATER && b !== ID.VOID;
}
function tileOf(c, x, y) { return c.edits.get(x + ',' + y) || null; }
function ours(c, x, y) {
  const t = tileOf(c, x, y);
  return !!(t && t.owner === c.key);
}
function freeOrOurs(c, x, y) {
  const t = tileOf(c, x, y);
  return !t || t.owner === c.key;
}
function held(inv, k) { return (inv && inv[k] | 0) || 0; }
function canPay(inv, cost) {
  if (!cost) return true;
  for (const k of Object.keys(cost)) if (held(inv, k) < cost[k]) return false;
  return true;
}

function plotTiles(ox, oy, size) {
  const out = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push({ x: ox + dx, y: oy + dy });
  return out;
}
function findPlot(c, spawn, size) {
  const sx = Math.round(spawn.x), sy = Math.round(spawn.y);
  for (let r = SPAWN_KEEP + 2; r < 80; r++) {
    for (let a = 0; a < r * 6; a++) {
      const t = (a / (r * 6)) * Math.PI * 2;
      const ox = Math.round(sx + Math.cos(t) * r);
      const oy = Math.round(sy + Math.sin(t) * r);
      let ok = true;
      for (let dy = 0; dy < size && ok; dy++) {
        for (let dx = 0; dx < size && ok; dx++) {
          const x = ox + dx, y = oy + dy;
          if (!dry(c.map, x, y) || !freeOrOurs(c, x, y)) ok = false;
          if (hypot(x, y, sx, sy) < SPAWN_KEEP) ok = false;
        }
      }
      if (ok) return { ox, oy };
    }
  }
  return null;
}

async function walkTo(c, tx, ty, within) {
  within = within == null ? 1.2 : within;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const d = hypot(c.x, c.y, tx, ty);
    if (d <= within) return d;
    const step = Math.min(1.2, d);
    const nx = c.x + (tx - c.x) / d * step;
    const ny = c.y + (ty - c.y) / d * step;
    c.send({ t: 'move', x: nx, y: ny });
    c.x = nx; c.y = ny;
    if ((Date.now() - t0) % 400 < 160) c.send({ t: 'view', x: Math.round(tx), y: Math.round(ty) });
    await sleep(jitter(110, 180));
  }
  return hypot(c.x, c.y, tx, ty);
}

function nearestNode(c, kindWant) {
  let best = null, bd = 1e9;
  c.nodes.forEach((n) => {
    if (n.state !== 1) return;
    if (kindWant != null && n.kind !== kindWant) return;
    const d = hypot(c.x, c.y, n.x, n.y);
    if (d > 80) return;
    if (d < bd) { bd = d; best = n; }
  });
  return best;
}
function nearestHopper(c) {
  let best = null, bd = 1e9;
  for (const e of c.mons) {
    const sp = T.speciesOf(c.map, e[1]);
    if (!sp || sp.kind !== 'MOSS_HOPPER') continue;
    const d = hypot(c.x, c.y, e[2], e[3]);
    if (d < bd) { bd = d; best = { x: e[2], y: e[3] }; }
  }
  return best;
}

async function harvestNearby(c, wantKind) {
  let n = nearestNode(c, wantKind);
  if (!n && c.spawn) {
    c.send({ t: 'view', x: Math.round(c.spawn.x), y: Math.round(c.spawn.y) });
    await walkTo(c, c.spawn.x, c.spawn.y, 5);
    await sleep(350);
    n = nearestNode(c, wantKind) || nearestNode(c, null);
  }
  if (!n) return false;
  const d = await walkTo(c, n.x, n.y, REACH - 1);
  if (d > REACH) return false;
  c.send({ t: 'harvest', x: n.x, y: n.y });
  n.state = 0;
  await sleep(jitter(700, 1400));
  return true;
}

async function claimTile(c, x, y, mat) {
  if (ours(c, x, y)) return true;
  const d = await walkTo(c, x, y, REACH - 1);
  if (d > REACH) return false;
  if (!canPay(c.inv, { wood: 1 }) && mat === ID.DIRT) return false;
  c.send({ t: 'set', x, y, m: mat });
  try {
    await c.waitFor(m => (m.t === 'you' && m.x === x && m.y === y) || (m.t === 'deny' && m.x === x && m.y === y), 1500);
  } catch (e) {}
  return ours(c, x, y);
}

async function homestead(c, st, deadline) {
  const spawn = c.spawn || T.spawnPoint(c.map);
  let ox = st.ox, oy = st.oy;
  if (ox == null || oy == null) {
    const found = findPlot(c, spawn, PLOT);
    if (!found) { log('no free plot near spawn'); return st; }
    ox = found.ox; oy = found.oy;
    st.ox = ox; st.oy = oy; st.map = c.map; saveState(st);
    log('homestead origin', ox + ',' + oy, 'size', PLOT);
  }
  const tiles = plotTiles(ox, oy, PLOT);
  const unclaimed = tiles.filter(t => !ours(c, t.x, t.y));
  if (unclaimed.length) {
    log('claiming', unclaimed.length, 'tiles as dirt (need wood)');
    for (const t of unclaimed) {
      if (deadline && Date.now() > deadline) break;
      let guard = 0;
      while (!canPay(c.inv, { wood: 1 }) && guard++ < 6) {
        const did = await harvestNearby(c, 1) || await harvestNearby(c, null);
        if (!did) break;
      }
      if (!canPay(c.inv, { wood: 1 })) { log('short on wood, will resume', JSON.stringify(c.inv)); break; }
      await claimTile(c, t.x, t.y, ID.DIRT);
      if (ours(c, t.x, t.y)) log('claimed', t.x + ',' + t.y, 'wood', held(c.inv, 'wood'));
    }
  }
  const owned = tiles.filter(t => ours(c, t.x, t.y));
  log('owned', owned.length + '/' + tiles.length, 'inv', JSON.stringify(c.inv));

  if (!st.parcelMinted && owned.length === tiles.length) {
    c.send({ t: 'parcel-mint', name: PARCEL, tiles: owned });
    try {
      const r = await c.waitFor(m => m.t === 'parcel-minted', 4000);
      if (r && !r.err) { st.parcelMinted = true; saveState(st); log('named parcel', PARCEL); }
      else log('parcel', r && r.err);
    } catch (e) { log('parcel timeout (handler may be older server)'); }
  }

  const cx = ox + ((PLOT / 2) | 0), cy = oy + ((PLOT / 2) | 0);
  if (ours(c, cx, cy) && !c.structures.get(cx + ',' + cy) && canPay(c.inv, { wood: 6, herb: 3 })) {
    await walkTo(c, cx, cy, 1.5);
    c.send({ t: 'build-structure', x: cx, y: cy, kind: 'apiary' });
    try {
      const r = await c.waitFor(m => m.t === 'built', 4000);
      if (r && !r.err) log('built apiary at', cx + ',' + cy);
      else log('apiary', r && r.err);
    } catch (e) { log('apiary timeout'); }
    await sleep(400);
  }

  const stAt = c.structures.get(cx + ',' + cy);
  if (stAt && (stAt.accrued | 0) > 0) {
    await walkTo(c, cx, cy, 1.5);
    c.send({ t: 'collect-structure', x: cx, y: cy });
    await sleep(500);
  }
  return st;
}

async function maybeTame(c) {
  const pet = c.pet || {};
  const owned = Array.isArray(pet.owned) ? pet.owned : [];
  if (owned.indexOf('moss_hopper') >= 0) {
    if (!pet.active && held(c.inv, 'honey') >= 1 && (pet.treatLeftMs | 0) === 0) {
      c.send({ t: 'pet-treat', id: 'moss_hopper' });
      await sleep(400);
    }
    return;
  }
  if (held(c.inv, 'honey') < 5) return;
  const hop = nearestHopper(c);
  if (!hop) return;
  const d = await walkTo(c, hop.x, hop.y, REACH - 1);
  if (d > REACH) return;
  c.send({ t: 'tame', id: 'moss_hopper' });
  try {
    const r = await c.waitFor(m => m.t === 'pet', 4000);
    log('tame', r && (r.ok === false ? (r.err || r.error) : (r.pet && r.pet.name)));
  } catch (e) { log('tame timeout (pets may not be deployed yet)'); }
}

async function wander(c, st) {
  const ox = st.ox, oy = st.oy;
  if (ox == null) return;
  const tx = ox + Math.random() * PLOT;
  const ty = oy + Math.random() * PLOT;
  await walkTo(c, tx, ty, 1.4);
  if (c.players && c.players.length && Math.random() < 0.15) {
    c.send({ t: 'emote', id: 'wave' });
  }
  await harvestNearby(c, null);
}

async function session() {
  const key = loadKey();
  let st = loadState();
  const target = parseUrl(BASE);
  log('connecting', BASE, 'as', NAME, ONCE ? '(once)' : '(loop)');
  const c = new Client();
  await c.connect(target);
  c.send({ t: 'hello', key, name: NAME });
  await c.waitFor(m => m.t === 'welcome', 10000);
  log('in world', 'map', c.map, 'at', Math.round(c.x) + ',' + Math.round(c.y), 'inv', JSON.stringify(c.inv));
  c.send({ t: 'set-look', paletteId: PALETTE });
  c.send({ t: 'view', x: Math.round(c.x), y: Math.round(c.y) });
  await sleep(400);

  const ping = setInterval(() => { try { c.send({ t: 'ping', c: Date.now() }); } catch (e) {} }, 20000);
  const tEnd = Date.now() + (ONCE ? 3 * 60 * 1000 : 365 * 24 * 3600 * 1000);
  try {
    while (Date.now() < tEnd && c.socket && !c.socket.destroyed) {
      st = await homestead(c, st, tEnd);
      await maybeTame(c);
      await wander(c, st);
      await sleep(jitter(800, 1800));
      if (ONCE && st.parcelMinted && c.structures.size) break;
    }
  } finally {
    clearInterval(ping);
    c.close();
  }
  log('session done owned-plot', st.ox + ',' + st.oy, 'parcel', !!st.parcelMinted);
}

(async function main() {
  for (;;) {
    try { await session(); } catch (e) { log('session error', e && e.message); }
    if (ONCE) break;
    await sleep(4000);
  }
})().catch(e => { console.error(e); process.exit(1); });
