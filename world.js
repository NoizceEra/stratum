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
 *
 * COMBAT (all of it authoritative, all of it decided here):
 *   species data   every stat, resistance, wind-up, loot roll and XP value lives in
 *                  public/terrain.js as data — this file only *runs* it.
 *   aggro/leash    a monster chases a player inside its aggro radius, and walks back to
 *                  its generated home point when it is dragged past its leash length.
 *   wind-up        a blow is telegraphed (sp.windupMs) and then resolved: step out of
 *                  reach during the wind-up and the blow misses. That is the dodge.
 *   damage         variance (±18%), crits, per-type resistances (physical/fire/ice).
 *   progression    per-species XP to the killer, a level curve, and max HP + attack
 *                  DERIVED from that level (never stored).
 *   loot           per-species tables rolled on death and granted to the killer's
 *                  inventory — one victim, one looter.
 *   movement       every step is validated: no water, no void, never off the map.
 */
const T = require('./public/terrain.js');

const VIEW_CHUNKS = 3;          // chunk radius of nodes materialised around a player
const MON_ACTIVATE = 3;         // chunk radius of monster homes materialised
const MON_SEND_RANGE = 64;      // tiles: monsters a client is told about
const ATTACK_RANGE = 3;         // tiles: how close you must be to hit something
const MON_DEAGGRO = 90;         // tiles: beyond this a monster stops simulating at all
const WANDER_R = 7;             // tiles: how far from home an idle monster roams
const PLAYER_SWING_MS = 250;    // your own recovery — you cannot spam blows
const MON_PACKET_MAX = 40;      // monsters per 'mons' packet
const REGEN_DELAY_MS = T.COMBAT.regenDelayMs;
// Tests shrink the respawn clocks so the real reset loop can be observed in seconds.
const RS = Number(process.env.STRATUM_RESPAWN_SCALE || 1);

/** What a creature is doing. Shipped to clients as an extra field on every 'mons' row. */
const MODE = { IDLE: 0, CHASE: 1, RETURN: 2, DEAD: 3 };
/** What its body is doing: 0 free, 1 winding up (the dodge window), 2 recovering. */
const PHASE = { IDLE: 0, WINDUP: 1, RECOVER: 2 };

const RESOURCES = ['wood', 'ore', 'herb', 'crystal'];

function r1(v) { return Math.round(v * 10) / 10; }

class World {
  constructor(db) {
    this.db = db;
    this.nodeState = new Map();   // "map:x:y" -> {kind, state, ripe, hp}
    this.monsters = new Map();    // "map:hx:hy" -> monster
    this.monById = new Map();
    this.chunkNodes = new Map();  // "map:cx:cy" -> [[x,y,kindId],...]
    this.chunkMons = new Map();
    this.hunters = new Map();     // player key -> {key, xp, level, kills, name}
    this.nextMonId = 1;
    this.totalKills = 0;

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

  /** Bring monster homes near a point into existence (they start alive, at home). */
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
          const kindIdx = e[2] % list.length;
          const sp = list[kindIdx];
          const m = {
            id: this.nextMonId++, map, kindIdx, sp,
            hx: e[0] + 0.5, hy: e[1] + 0.5,               // the generated home point
            x: e[0] + 0.5, y: e[1] + 0.5,
            hp: sp.hp, maxHp: sp.hp,
            state: 1, ripe: 0,
            respawnMs: T.respawnMsFor(sp),                // tier-scaled reset clock
            mode: MODE.IDLE, phase: PHASE.IDLE, phaseUntil: 0,
            nextAtk: 0, chargeReady: 0, charging: false,
            dashUntil: 0, dashVX: 0, dashVY: 0, dashSpeed: 0,
            wx: e[0] + 0.5, wy: e[1] + 0.5, wUntil: 0,
            slide: Math.random() < 0.5 ? -1 : 1, blocked: 0,
            lastAtk: 0, lastHitAt: 0, target: null, hits: 0, taken: 0, calledBy: 0
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

  // ---------- progression --------------------------------------------------
  /** The hunter record for a player: lifetime XP, level, kills. Created on first blood. */
  hunter(p) {
    const key = p.key || ('anon' + (p.id || 0));
    let h = this.hunters.get(key);
    if (!h) {
      // a returning player keeps a little of what their kill count implies
      const seed = Math.max(0, (p.kills | 0) * 4);
      h = { key, name: p.name || '', xp: seed, level: T.levelFromXp(seed).level, kills: p.kills | 0, levelsGained: 0, seen: Date.now() };
      this.hunters.set(key, h);
      this.syncDerived(h, p);
    }
    h.name = p.name || h.name;
    h.seen = Date.now();
    if (this.hunters.size > 5000) {                 // never grow forever on a long-lived server
      const cut = Date.now() - 3600000;
      for (const [k, v] of this.hunters) if (v.seen < cut) this.hunters.delete(k);
    }
    return h;
  }

  /** Level is derived from XP; max HP and attack are derived from level. */
  syncDerived(h, p) {
    const lv = T.levelFromXp(h.xp);
    h.level = lv.level;
    if (p) {
      p.xp = h.xp;
      p.level = lv.level;
      p.maxHp = T.maxHpForLevel(lv.level);
      p.atk = T.attackForLevel(lv.level);
      if (p.hp > p.maxHp) p.hp = p.maxHp;
    }
    return h;
  }

  /** Award XP to the killer only, and re-derive what that buys. */
  awardXp(p, amount) {
    const h = this.hunter(p);
    const before = h.level;
    h.xp += Math.max(0, amount | 0);
    h.kills = p.kills | 0;
    this.syncDerived(h, p);
    if (h.level > before) h.levelsGained += (h.level - before);
    return h;
  }

  /** Roll a species' loot and hand it to the killer. Returns {grants, primary}. */
  grantLoot(m, p) {
    const roll = T.rollLoot(m.sp, Math.random);
    const grants = {};
    for (const k of Object.keys(roll.grants)) {
      if (RESOURCES.indexOf(k) < 0) continue;          // never write junk into an inventory
      const n = roll.grants[k];
      if (n > 0) grants[k] = n;
    }
    if (p && p.inv) for (const k of Object.keys(grants)) p.inv[k] = (p.inv[k] || 0) + grants[k];
    const primary = Object.keys(grants)[0] || roll.primary || m.sp.loot;
    return { grants, primary };
  }

  // ---------- movement -----------------------------------------------------
  /**
   * Can a creature stand here? Never water, never void, never off the map.
   * Positions are tile CENTRES (home = tile + 0.5), so the tile is floor(), not round().
   */
  canStand(map, x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 1 || ty < 1 || tx >= T.W - 1 || ty >= T.H - 1) return false;
    const b = T.baseTypeFor(map, tx, ty);
    return b !== T.ID.WATER && b !== T.ID.VOID;
  }

  /**
   * Take one step along a direction, refusing anything that would enter water, void or
   * the border. Fans out from the wanted heading (0, ±22.5°, ±45°, ±67.5°, ±90°) and
   * remembers which way it had to go around, so a creature follows a shoreline instead
   * of shuffling against it — and it never crosses the water.
   */
  stepDir(m, ux, uy, dist) {
    const L = Math.hypot(ux, uy);
    if (!(L > 1e-9) || !(dist > 0)) return 0;
    const base = Math.atan2(uy, ux);
    const side = m.slide || 1;
    const fan = [0,
      0.3927 * side, 0.7854 * side, 1.1781 * side, 1.5708 * side,
      -0.3927 * side, -0.7854 * side, -1.1781 * side, -1.5708 * side];
    for (let i = 0; i < fan.length; i++) {
      const nx = m.x + Math.cos(base + fan[i]) * dist, ny = m.y + Math.sin(base + fan[i]) * dist;
      if (!this.canStand(m.map, nx, ny)) continue;
      if (i > 0) {
        m.blocked = (m.blocked || 0) + 1;
        if (m.blocked > 8) { m.slide = -side; m.blocked = 0; }   // dead end: try the other way
      } else m.blocked = 0;
      m.x = nx; m.y = ny;
      return 1;
    }
    m.blocked = 0;
    m.slide = -side;
    return 0;
  }

  // ---------- combat -------------------------------------------------------
  /**
   * A player swings at a monster. Returns:
   *   {err}                                     refused (range / cooldown / gone)
   *   {ok, killed:false, hp, maxHp, dmg, crit}  hit, still standing
   *   {ok, killed:true, loot, xp, kills, ...}   dead: loot + XP go to the killer
   */
  attack(player, monId) {
    const now = Date.now();
    const m = this.monById.get(monId);
    if (!m || m.state !== 1 || m.map !== player.map) return { err: 'no such creature' };
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d > ATTACK_RANGE + 1) return { err: 'out of range' };
    if (player.nextSwing && now < player.nextSwing) {
      return { err: 'recovering', wait: Math.round(player.nextSwing - now) };
    }
    player.nextSwing = now + PLAYER_SWING_MS;

    const h = this.hunter(player);
    this.syncDerived(h, player);                  // your level decides your attack
    const type = player.dmgType || T.DEFAULT_DMG_TYPE;
    const roll = T.damageRoll(player.atk + (player.atkBoost | 0), T.COMBAT.critChance, T.COMBAT.critMul);
    const dmg = Math.max(1, Math.round(T.applyResist(type, roll.dmg, m.sp)));

    m.hp -= dmg;
    m.lastHitAt = now;
    m.taken += dmg;
    if (m.state === 1 && m.mode !== MODE.RETURN) {
      if (m.mode !== MODE.CHASE) this.onAggro(m, player, now, null);
      else m.target = player.key;
    }

    if (m.hp <= 0) {
      m.hp = 0;
      m.state = 0;                                // DEAD: leaves the wire, arms the reset
      m.ripe = now + m.respawnMs * RS;
      m.x = m.hx; m.y = m.hy;                      // the corpse goes home to reset
      m.mode = MODE.DEAD; m.phase = PHASE.IDLE;
      m.dashUntil = 0; m.charging = false; m.target = null;
      this.totalKills++;
      const loot = this.grantLoot(m, player);
      h.kills = player.kills | 0;
      const before = h.level;
      const xp = m.sp.xp | 0;
      this.awardXp(player, xp);
      return {
        ok: true, killed: true, name: m.sp.kind, form: m.sp.form, tier: m.sp.tier,
        loot: loot.primary, lootAll: loot.grants, xp, ripe: m.ripe,
        level: h.level, levelUp: h.level > before,
        dmg, crit: roll.crit, type, dmgType: m.sp.dmgType, id: m.id
      };
    }
    return {
      ok: true, killed: false, name: m.sp.kind, hp: m.hp, maxHp: m.maxHp,
      dmg, crit: roll.crit, type, id: m.id
    };
  }

  /** A monster lands one blow on a player (rolls variance + crit, applies resistance). */
  monsterHits(m, p, now, out) {
    const sp = m.sp;
    const roll = T.damageRoll(sp.atk, T.COMBAT.monCritChance, T.COMBAT.monCritMul);
    const type = sp.dmgType || T.DEFAULT_DMG_TYPE;
    const dmg = Math.max(1, Math.round(T.applyResist(type, roll.dmg, p)));
    m.lastAtk = now;
    m.hits++;
    if (out) out.hits.push({ key: p.key, dmg, name: sp.kind, id: m.id, crit: roll.crit, type, x: r1(m.x), y: r1(m.y) });
    return dmg;
  }

  /** Something has noticed a player. Pack hunters shout, and the shout sticks. */
  onAggro(m, p, now, out) {
    m.mode = MODE.CHASE;
    m.target = p.key;
    const pk = m.sp.pack;
    if (!pk) return;
    let called = 0;
    const ids = [];
    for (const o of this.monsters.values()) {
      if (o === m || o.state !== 1 || o.sp !== m.sp || o.map !== m.map) continue;
      if (o.mode === MODE.CHASE) continue;
      if (Math.hypot(o.x - m.x, o.y - m.y) > (pk.callRadius || 20)) continue;
      o.mode = MODE.CHASE;
      o.target = p.key;
      o.calledBy = m.id;
      ids.push(o.id);
      called++;
      if (called >= (pk.maxAllies || 2)) break;
    }
    if (called && out) out.calls.push({ by: m.id, kind: m.sp.kind, ids });
  }

  /**
   * One creature, one tick. Grounded in three rules: it never enters water or leaves the
   * map, it never lands a blow it did not telegraph, and it never strays past its leash.
   */
  stepMonster(m, players, now, out) {
    const sp = m.sp;

    // ---- who is worth noticing? -------------------------------------------
    let near = null, best = Infinity;
    for (const p of players) {
      if (p.dead || p.map !== m.map) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < best) { best = d; near = p; }
    }
    if (!near || best > MON_DEAGGRO) { near = null; best = Infinity; }

    const dHome = Math.hypot(m.x - m.hx, m.y - m.hy);
    const leash = sp.leash || 14;

    // ---- mid-charge: the body is committed --------------------------------
    if (m.dashUntil && now < m.dashUntil) {
      m.mode = MODE.CHASE;
      m.phase = PHASE.IDLE;
      this.stepDir(m, m.dashVX, m.dashVY, m.dashSpeed * 0.1);
      if (near && Math.hypot(near.x - m.x, near.y - m.y) <= sp.melee + 0.7) {
        this.monsterHits(m, near, now, out);
        m.dashUntil = 0;
        m.nextAtk = now + sp.cooldownMs;
      }
      return;
    }
    if (m.dashUntil) m.dashUntil = 0;

    // ---- telegraphed blow in flight ---------------------------------------
    if (m.phase === PHASE.WINDUP) {
      if (now < m.phaseUntil) return;              // rooted: THIS is the dodge window
      const wasCharge = m.charging;
      m.charging = false;
      m.phase = PHASE.IDLE;
      if (wasCharge && near) {
        const dx = near.x - m.x, dy = near.y - m.y, L = Math.hypot(dx, dy) || 1;
        m.dashVX = dx / L; m.dashVY = dy / L;
        m.dashSpeed = sp.speed * ((sp.charge && sp.charge.dashMul) || 2.6);
        m.dashUntil = now + ((sp.charge && sp.charge.dashMs) || 800);
        m.chargeReady = now + ((sp.charge && sp.charge.cooldownMs) || 4000);
        return;
      }
      const reach = sp.ranged || sp.melee;
      if (near && best <= reach + 0.6) this.monsterHits(m, near, now, out);   // you stayed
      m.nextAtk = now + sp.cooldownMs;
      return;
    }

    // ---- state transitions -------------------------------------------------
    if (m.mode !== MODE.RETURN) {
      // an ally that was called knows where you are: it stays on you much further out
      const holdRange = m.calledBy ? MON_DEAGGRO : sp.aggro * 1.4;
      if (dHome > leash) {                          // dragged too far: give up, go home
        m.mode = MODE.RETURN;
        m.target = null;
      } else if (near && best <= sp.aggro) {
        if (m.mode !== MODE.CHASE) this.onAggro(m, near, now, out);
        else m.target = near.key;
      } else if (m.mode === MODE.CHASE && (!near || best > holdRange)) {
        m.mode = MODE.IDLE;                         // lost interest
        m.target = null;
        m.calledBy = 0;
      } else if (m.mode !== MODE.CHASE && dHome > WANDER_R) {
        m.mode = MODE.RETURN;
      }
    }
    if (m.mode === MODE.RETURN) {
      if (dHome <= 1.2) { m.mode = MODE.IDLE; m.target = null; m.calledBy = 0; }
      else { this.stepDir(m, m.hx - m.x, m.hy - m.y, sp.speed * 0.125); return; }
    }

    // ---- hunting -----------------------------------------------------------
    if (m.mode === MODE.CHASE && near) {
      const reach = sp.ranged || sp.melee;
      const ch = sp.charge;
      if (ch && !m.dashUntil && now >= m.chargeReady && m.phase === PHASE.IDLE &&
          best > sp.melee + 0.5 && best <= ch.range) {
        m.charging = true;                          // brute: paw the ground, then run
        m.phase = PHASE.WINDUP;
        m.phaseUntil = now + ch.windupMs;
        return;
      }
      if (m.phase === PHASE.IDLE && now >= m.nextAtk && best <= reach + 0.5) {
        m.phase = PHASE.WINDUP;                     // spitter or brawler: telegraph it
        m.phaseUntil = now + sp.windupMs;
        return;
      }
      if (sp.role === 'kiter' || sp.role === 'spitter') {
        // ranged skirmisher: retreat inside keepAway, close to shootRange, hold in between
        if (best < (sp.keepAway || 4)) this.stepDir(m, m.x - near.x, m.y - near.y, sp.speed * 0.1);
        else if (best > (sp.shootRange || reach)) this.stepDir(m, near.x - m.x, near.y - m.y, sp.speed * 0.1);
      } else if (best > sp.melee * 0.8) {
        this.stepDir(m, near.x - m.x, near.y - m.y, sp.speed * 0.1);
      }
      return;
    }

    // ---- idle: drift around home -------------------------------------------
    m.mode = MODE.IDLE;
    if (now > m.wUntil) {
      m.wUntil = now + 2000 + Math.random() * 6000;
      const a = Math.random() * Math.PI * 2, r = 1 + Math.random() * WANDER_R;
      m.wx = m.hx + Math.cos(a) * r;
      m.wy = m.hy + Math.sin(a) * r;
    }
    const L = Math.hypot(m.wx - m.x, m.wy - m.y);
    if (L > 0.3 && !this.stepDir(m, m.wx - m.x, m.wy - m.y, Math.min(sp.speed * 0.05, L))) m.wUntil = 0;
  }

  // ---------- tick ---------------------------------------------------------
  /**
   * Advance monsters and node resets. Returns {nodeRevived:[...], monsterDead:[...],
   * hits:[{key, dmg, name}]} for the server to relay.
   */
  tick(players, now) {
    const revived = [], hits = [], respawned = [], calls = [];

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

    // every live hunter's derived stats are re-derived from their level
    for (const p of players) {
      if (p.dead) continue;
      const h = this.hunter(p);
      this.syncDerived(h, p);
      h.kills = p.kills | 0;
    }

    // monsters
    const out = { hits, calls };
    for (const m of this.monsters.values()) {
      if (m.state === 0) {
        if (m.ripe <= now) {
          m.state = 1; m.hp = m.maxHp; m.x = m.hx; m.y = m.hy;   // respawn AT HOME
          m.mode = MODE.IDLE; m.phase = PHASE.IDLE; m.nextAtk = 0;
          m.dashUntil = 0; m.charging = false; m.target = null; m.taken = 0; m.hits = 0;
          m.calledBy = 0; m.lastHitAt = 0;
          if (players.some(p => p.map === m.map && Math.abs(p.x - m.x) < MON_SEND_RANGE)) {
            respawned.push({ map: m.map, id: m.id, kind: m.kindIdx, name: m.sp.kind, x: m.x, y: m.y, tier: m.sp.tier });
          }
        }
        continue;
      }

      // only simulate where someone can see it
      let seen = false;
      for (const p of players) {
        if (p.dead || p.map !== m.map) continue;
        if (Math.abs(p.x - m.x) < MON_DEAGGRO && Math.abs(p.y - m.y) < MON_DEAGGRO) { seen = true; break; }
      }
      if (!seen) continue;

      // a wounded creature that nobody has touched for a while knits itself back up
      if (m.hp < m.maxHp && m.lastHitAt && now - m.lastHitAt > REGEN_DELAY_MS) {
        m.hp = Math.min(m.maxHp, m.hp + Math.max(1, Math.round(m.maxHp / 100)));
      }

      this.stepMonster(m, players, now, out);
    }

    return { revived, hits, respawned, calls };
  }

  /**
   * Wire-ready monsters near a player:
   *   [id, speciesIdx, x, y, hp, maxHp, mode, phase, tier]
   * The first six indices are the original protocol; the rest are combat telemetry the
   * renderer may use (and the combat tests do).
   */
  nearby(map, x, y) {
    const out = [];
    for (const m of this.monsters.values()) {
      if (m.map !== map) continue;
      if (Math.abs(m.x - x) > MON_SEND_RANGE || Math.abs(m.y - y) > MON_SEND_RANGE) continue;
      if (m.state === 0) continue;
      out.push([m.id, m.kindIdx, r1(m.x), r1(m.y), Math.round(m.hp), m.maxHp, m.mode, m.phase, m.sp.tier]);
      if (out.length >= MON_PACKET_MAX) break;
    }
    return out;
  }

  stats() {
    let alive = 0, dead = 0, depleted = 0;
    const byForm = {};
    for (const m of this.monsters.values()) {
      if (m.state === 1) { alive++; byForm[m.sp.form] = (byForm[m.sp.form] || 0) + 1; }
      else dead++;
    }
    for (const s of this.nodeState.values()) if (s.state === 0) depleted++;
    return {
      monstersLive: alive, monstersWaiting: dead, monstersKnown: this.monsters.size,
      nodesDepleted: depleted, kills: this.totalKills, forms: byForm,
      // hunter records are keyed by a non-reversible tag — a player key is an auth token
      hunters: [...this.hunters.values()].map(h => ({
        k: T.keyTag(h.key), name: h.name, xp: h.xp, level: h.level,
        maxHp: T.maxHpForLevel(h.level), atk: T.attackForLevel(h.level), kills: h.kills
      }))
    };
  }
}

module.exports = { World, ATTACK_RANGE, MON_SEND_RANGE, MODE, PHASE, PLAYER_SWING_MS, RS };
