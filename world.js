'use strict';
/**
 * world.js — STRATUM's VOLATILE layer.
 *
 * This is the half of the world that RESETS. Resources and monsters are provisions of
 * the world: generated from (map, x, y) by terrain.js, held in memory, and cycled by
 * respawn timers. Nothing here is authored by a player, so nothing here can be lost by
 * resetting it. That is the whole reason the persistent land layer can be permanent.
 *
 * Persisted to SQLite: ONLY which nodes are currently depleted and when they come back,
 * so a server restart is not a free harvest. Monsters are deliberately not persisted —
 * they are the reset.
 */
const T = require('./public/terrain.js');

const VIEW_CHUNKS = 3;          // chunk radius of nodes materialised around a player
const MON_ACTIVATE = 3;         // chunk radius of monster homes materialised
const MON_SEND_RANGE = 64;      // tiles: monsters a client is told about
const ATTACK_RANGE = 3;         // tiles: how close you must be to hit something
// Tests shrink the respawn clocks so the real reset loop can be observed in seconds.
const RS = Number(process.env.STRATUM_RESPAWN_SCALE || 1);

class World {
  constructor(db) {
    this.db = db;
    this.nodeState = new Map();   // "map:x:y" -> {kind, state, ripe, hp}
    this.monsters = new Map();    // "map:hx:hy" -> monster
    this.monById = new Map();
    this.chunkNodes = new Map();  // "map:cx:cy" -> [[x,y,kindId],...]
    this.chunkMons = new Map();
    this.nextMonId = 1;

    db.exec(`
      CREATE TABLE IF NOT EXISTS depleted(
        map INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
        kind INTEGER NOT NULL, ripe INTEGER NOT NULL, PRIMARY KEY(map,x,y));
    `);
    this.qDeplete = db.prepare('INSERT OR REPLACE INTO depleted(map,x,y,kind,ripe) VALUES(?,?,?,?,?)');
    this.qRevive = db.prepare('DELETE FROM depleted WHERE map=? AND x=? AND y=?');
    this.qLoaded = db.prepare('SELECT map,x,y,kind,ripe FROM depleted');

    const now = Date.now();
    let n = 0;
    for (const r of this.qLoaded.all()) {
      // nodes that came back while we were down are simply alive again
      if (r.ripe <= now) { this.qRevive.run(r.map, r.x, r.y); continue; }
      this.nodeState.set(r.map + ':' + r.x + ':' + r.y, { kind: r.kind, state: 0, ripe: r.ripe, hp: 0 });
      n++;
    }
    console.log(`[volatile] ${n} depleted resource nodes still regrowing`);
  }

  // ---------- lazy generation ---------------------------------------------
  nodesInChunk(map, cx, cy) {
    const key = map + ':' + cx + ':' + cy;
    let gen = this.chunkNodes.get(key);
    if (gen === undefined) {
      gen = T.nodesInChunk(map, cx, cy);
      this.chunkNodes.set(key, gen);
      if (this.chunkNodes.size > 4000) this.chunkNodes.clear();
    }
    return gen;
  }

  /** Materialise node state for a chunk and return wire-ready entries. */
  nodesForChunk(map, cx, cy) {
    const gen = this.nodesInChunk(map, cx, cy);
    if (!gen.length) return [];
    const out = [];
    const now = Date.now();
    for (const e of gen) {
      const x = e[0], y = e[1], kindId = e[2];
      const sk = map + ':' + x + ':' + y;
      let st = this.nodeState.get(sk);
      if (!st) {
        const kind = T.kindById(kindId);
        st = { kind: kindId, state: 1, ripe: 0, hp: T.NODE_KINDS[kind].hp };
        this.nodeState.set(sk, st);
      }
      const ripeSec = st.state === 0 ? Math.max(0, Math.ceil((st.ripe - now) / 1000)) : 0;
      out.push([x, y, kindId, st.state, ripeSec]);
    }
    return out;
  }

  monstersInChunk(map, cx, cy) {
    const key = map + ':' + cx + ':' + cy;
    let gen = this.chunkMons.get(key);
    if (gen === undefined) {
      gen = T.monstersInChunk(map, cx, cy);
      this.chunkMons.set(key, gen);
      if (this.chunkMons.size > 4000) this.chunkMons.clear();
    }
    return gen;
  }

  /** Bring monster homes near a point into existence (they start alive). */
  activate(map, x, y) {
    const ccx = T.chunkOf(x), ccy = T.chunkOf(y);
    const list = T.SPECIES[map] || T.SPECIES[0];
    for (let dy = -MON_ACTIVATE; dy <= MON_ACTIVATE; dy++) {
      for (let dx = -MON_ACTIVATE; dx <= MON_ACTIVATE; dx++) {
        const cx = ccx + dx, cy = ccy + dy;
        if (cx < 0 || cy < 0 || cx * T.CHUNK >= T.W || cy * T.CHUNK >= T.H) continue;
        for (const e of this.monstersInChunk(map, cx, cy)) {
          const k = map + ':' + e[0] + ':' + e[1];
          if (this.monsters.has(k)) continue;
          const sp = list[e[2]] || list[0];
          const m = {
            id: this.nextMonId++, map, hx: e[0] + 0.5, hy: e[1] + 0.5,
            x: e[0] + 0.5, y: e[1] + 0.5, sp, hp: sp.hp, maxHp: sp.hp,
            state: 1, ripe: 0, wx: e[0] + 0.5, wy: e[1] + 0.5, wUntil: 0,
            lastAtk: 0, target: null
          };
          this.monsters.set(k, m);
          this.monById.set(m.id, m);
        }
      }
    }
  }

  // ---------- harvest ------------------------------------------------------
  /**
   * Harvest a node. Returns {ok, kind, yields, amount, invDelta} or {err}.
   * The node depletes and schedules its own reset.
   */
  harvest(player, x, y) {
    const map = player.map;
    const gen = this.nodesInChunk(map, T.chunkOf(x), T.chunkOf(y));
    let found = null;
    for (const e of gen) if (e[0] === x && e[1] === y) { found = e; break; }
    if (!found) return { err: 'no node here' };
    const kindId = found[2], kind = T.kindById(kindId), def = T.NODE_KINDS[kind];
    const sk = map + ':' + x + ':' + y;
    let st = this.nodeState.get(sk);
    if (!st) { st = { kind: kindId, state: 1, ripe: 0, hp: def.hp }; this.nodeState.set(sk, st); }
    if (st.state === 0) return { err: 'still regrowing', wait: Math.ceil((st.ripe - Date.now()) / 1000) };

    st.hp -= 1;
    if (st.hp > 0) {
      return { ok: true, kind: kindId, partial: true, yields: def.yields, amount: 0 };
    }
    // exhausted -> the reset starts now
    st.state = 0;
    st.ripe = Date.now() + def.respawnMs * RS;
    st.hp = def.hp;
    this.qDeplete.run(map, x, y, kindId, st.ripe);
    return { ok: true, kind: kindId, yielded: true, yields: def.yields, amount: def.amount, ripe: st.ripe };
  }

  // ---------- combat -------------------------------------------------------
  attack(player, monId) {
    const m = this.monById.get(monId);
    if (!m || m.state !== 1 || m.map !== player.map) return { err: 'no such creature' };
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d > ATTACK_RANGE + 1) return { err: 'out of range' };
    m.hp -= player.atk;
    m.target = player.key;
    if (m.hp <= 0) {
      m.hp = 0; m.state = 0; m.ripe = Date.now() + m.sp.respawnMs * RS;
      m.x = m.hx; m.y = m.hy;
      return { ok: true, killed: true, name: m.sp.kind, loot: m.sp.loot, xp: m.sp.xp, ripe: m.ripe, id: m.id };
    }
    return { ok: true, killed: false, name: m.sp.kind, hp: m.hp, maxHp: m.maxHp, id: m.id };
  }

  // ---------- tick ---------------------------------------------------------
  /**
   * Advance monsters and node resets. Returns {nodeRevived:[...], monsterDead:[...],
   * hits:[{key, dmg, name}]} for the server to relay.
   */
  tick(players, now) {
    const revived = [], hits = [], respawned = [];

    // node resets
    for (const [sk, st] of this.nodeState) {
      if (st.state === 0 && st.ripe <= now) {
        st.state = 1; st.ripe = 0;
        const parts = sk.split(':');
        const map = +parts[0], x = +parts[1], y = +parts[2];
        // only bother if anyone is nearby
        if (players.some(p => p.map === map && Math.abs(p.x - x) < 60 && Math.abs(p.y - y) < 60)) {
          revived.push({ map, x, y, kind: st.kind });
          this.qRevive.run(map, x, y);
        }
      }
    }

    // monsters
    for (const m of this.monsters.values()) {
      if (m.state === 0) {
        if (m.ripe <= now) {
          m.state = 1; m.hp = m.maxHp; m.x = m.hx; m.y = m.hy;
          m.wx = m.hx; m.wy = m.hy; m.target = null;
          if (players.some(p => p.map === m.map && Math.abs(p.x - m.x) < MON_SEND_RANGE)) {
            respawned.push({ map: m.map, id: m.id, kind: m.sp.kind, x: m.x, y: m.y });
          }
        }
        continue;
      }

      // only simulate where someone can see it
      let near = null, best = 1e9;
      for (const p of players) {
        if (p.map !== m.map) continue;
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < best) { best = d; near = p; }
      }
      if (!near || best > 90) { m.target = null; continue; }

      if (best <= m.sp.aggro) {
        // chase
        m.target = near.key;
        const dx = near.x - m.x, dy = near.y - m.y, L = Math.hypot(dx, dy) || 1;
        const step = m.sp.speed * 0.1;
        if (best > 0.9) { m.x += (dx / L) * step; m.y += (dy / L) * step; }
        if (best <= 1.4 && now - m.lastAtk > 1200) {
          m.lastAtk = now;
          hits.push({ key: near.key, dmg: m.sp.atk, name: m.sp.kind, id: m.id });
        }
      } else {
        // wander around home
        m.target = null;
        if (now > m.wUntil) {
          m.wUntil = now + 2000 + Math.random() * 6000;
          const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * 7;
          m.wx = m.hx + Math.cos(a) * r;
          m.wy = m.hy + Math.sin(a) * r;
        }
        const dx = m.wx - m.x, dy = m.wy - m.y, L = Math.hypot(dx, dy);
        if (L > 0.3) {
          const step = m.sp.speed * 0.05;
          const nx = m.x + (dx / L) * step, ny = m.y + (dy / L) * step;
          const b = T.baseTypeFor(m.map, Math.round(nx), Math.round(ny));
          if (b !== T.ID.WATER && b !== T.ID.VOID) { m.x = nx; m.y = ny; }
          else m.wUntil = 0;
        }
      }
    }

    return { revived, hits, respawned };
  }

  /** Wire-ready monsters near a player. */
  nearby(map, x, y) {
    const out = [];
    for (const m of this.monsters.values()) {
      if (m.map !== map) continue;
      if (Math.abs(m.x - x) > MON_SEND_RANGE || Math.abs(m.y - y) > MON_SEND_RANGE) continue;
      if (m.state === 0) continue;
      let kindId = 1;
      const list = T.SPECIES[map] || T.SPECIES[0];
      for (let i = 0; i < list.length; i++) if (list[i] === m.sp) kindId = i;
      out.push([m.id, kindId, Math.round(m.x * 10) / 10, Math.round(m.y * 10) / 10, m.hp, m.maxHp]);
      if (out.length >= 40) break;
    }
    return out;
  }

  stats() {
    let alive = 0, dead = 0, depleted = 0;
    for (const m of this.monsters.values()) m.state === 1 ? alive++ : dead++;
    for (const s of this.nodeState.values()) if (s.state === 0) depleted++;
    return { monstersLive: alive, monstersWaiting: dead, monstersKnown: this.monsters.size, nodesDepleted: depleted };
  }
}

module.exports = { World, ATTACK_RANGE, MON_SEND_RANGE };
