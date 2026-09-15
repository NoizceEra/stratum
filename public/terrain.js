/**
 * terrain.js — deterministic base worlds for STRATUM.
 *
 * The base terrain is NEVER stored. It is a pure function of (map, x, y), so the client
 * generates it locally for free and only player edits travel over the wire. The server
 * requires this exact file to validate placements, so the two can never disagree about
 * what a world looks like.
 *
 * Every map is 1024x1024 tiles. Maps differ in generation, not in size.
 *
 * Works in the browser (window.Terrain) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Terrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1024, H = 1024, CHUNK = 32;

  var ID = {
    VOID: 0, DIRT: 1, GRASS: 2, STONE: 3, SAND: 4, WATER: 5, WOOD: 6, BRICK: 7,
    GLASS: 8, PATH: 9, LAMP: 10, GRASSDARK: 11, ROCK: 12, ORE: 13, SNOW: 14, LEAVES: 15
  };
  var PALETTE = [ID.DIRT, ID.GRASS, ID.STONE, ID.SAND, ID.WATER, ID.WOOD, ID.BRICK, ID.GLASS, ID.PATH, ID.LAMP];
  function isPlaceable(m) { return PALETTE.indexOf(m) >= 0; }

  /**
   * Maps. `params` drive generation; `nodes` drives the volatile resource layer.
   *   water  – sea level (higher = more ocean)
   *   ridge  – how much ridged noise (mountain chains) contributes to height
   *   scale  – base noise frequency (lower = bigger continents)
   *   tree   – leaf-tile threshold (higher = fewer forests)
   *   moist  – grass/dark-grass split
   *   ore    – ore threshold (lower = more ore)
   *   oreR   – ore threshold inside rock
   */
  // `tone` is the cozy-pivot flag (ROADMAP_COZY.md, Phase 0): 'sanctuary' maps will run
  // the gentle ambient-combat model once it's wired in (src/ambient-combat.js), 'frontier'
  // maps keep today's click/wind-up/dodge combat untouched. Adding the field here is a
  // pure data change — nothing branches on it yet, so behavior is identical either way
  // until the systems that actually read `tone` land.
  var MAPS = [
    {
      id: 0, name: 'THE FIRST ACRE', tier: 1, seed: 1337, tone: 'sanctuary',
      desc: 'Verdant and open. Where everyone starts and everything is built.',
      params: { water: 0.44, ridge: 0.30, scale: 0.035, tree: 0.50, moist: 0.53, ore: 0.72, oreR: 0.78 },
      nodes: { tree: 0.25, ore: 0.30, herb: 0.10, crystal: 0.004 }
    },
    {
      id: 1, name: 'ASHEN HOLLOW', tier: 2, seed: 4242, tone: 'frontier',
      desc: 'Broken rock and shallow soil. Almost nothing grows; everything is under it.',
      params: { water: 0.40, ridge: 0.85, scale: 0.050, tree: 0.60, moist: 0.80, ore: 0.58, oreR: 0.62 },
      nodes: { tree: 0.35, ore: 0.07, herb: 0.015, crystal: 0.010 }
    },
    {
      id: 2, name: 'THE SUNKEN SHELF', tier: 2, seed: 9001, tone: 'sanctuary',
      desc: 'Islands, shallows and salt. Land is scarce here, and contested.',
      params: { water: 0.52, ridge: 0.26, scale: 0.016, tree: 0.45, moist: 0.45, ore: 0.70, oreR: 0.72 },
      nodes: { tree: 0.15, ore: 0.35, herb: 0.20, crystal: 0.030 }
    }
  ];
  var MAP0 = MAPS[0];
  function mapDef(id) { return MAPS[id] || MAP0; }
  /** The cozy-pivot ruleset for a map: 'sanctuary' or 'frontier'. Unknown ids default to
   *  'frontier' — never silently soften an id nobody recognises. Checks the raw table
   *  directly rather than through mapDef(), which falls back to MAP0 for unknown ids and
   *  would otherwise leak MAP0's tone onto every bogus id. */
  function toneOf(id) { var d = MAPS[id]; return (d && d.tone === 'sanctuary') ? 'sanctuary' : 'frontier'; }

  // ---- deterministic integer hash (identical in every JS engine) ----------
  function hash2(x, y, s) {
    var h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function r01(x, y, s) { return hash2(x, y, s) / 4294967296; }

  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = r01(xi, yi, s), b = r01(xi + 1, yi, s);
    var c = r01(xi, yi + 1, s), d = r01(xi + 1, yi + 1, s);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  function fbm(x, y, s, oct) {
    var amp = 0.5, f = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 1013);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  }

  // ---- world shape --------------------------------------------------------
  var BORDER = 6;

  function elevationFor(mapId, x, y) {
    var def = mapDef(mapId), p = def.params, seed = def.seed;
    var e = fbm(x * p.scale, y * p.scale, seed, 5);
    var n = fbm(x * 0.028, y * 0.028, seed + 55, 4);
    var r = 1 - Math.abs(2 * n - 1);                 // ridged -> mountain chains
    var h = e * (1 - p.ridge) + r * r * p.ridge;
    var nx = (x - (W - 1) / 2) / ((W - 1) / 2);
    var ny = (y - (H - 1) / 2) / ((H - 1) / 2);
    var d = Math.min(1, Math.sqrt(nx * nx + ny * ny));
    var island = 1 - Math.pow(d, 2.2);
    return h * 0.52 + island * 0.56 - 0.10;
  }

  function baseTypeFor(mapId, x, y) {
    if (x < BORDER || y < BORDER || x >= W - BORDER || y >= H - BORDER) return ID.VOID;
    var def = mapDef(mapId), p = def.params, seed = def.seed;
    var e = elevationFor(mapId, x, y);
    // Bands are fractions of the elevation range left above the sand line. Fixed absolute
    // offsets invert on high-water maps (sand rises with sea level while the grass line
    // does not), which silently deletes whole biomes.
    var sand = p.water + 0.045;
    var span = 0.92 - sand;
    var low = sand + span * 0.32;
    var dirt = sand + span * 0.53;
    var stone = sand + span * 0.74;
    var rock = sand + span * 0.87;
    if (e < p.water) return ID.WATER;
    if (e < sand) return ID.SAND;
    if (e < low) {
      if (fbm(x * 0.085, y * 0.085, seed + 700, 2) > p.tree) return ID.LEAVES;
      return fbm(x * 0.008, y * 0.008, seed + 400, 3) > p.moist ? ID.GRASS : ID.GRASSDARK;
    }
    if (e < dirt) return ID.DIRT;
    if (e < stone) return fbm(x * 0.15, y * 0.15, seed + 900, 2) > p.ore ? ID.ORE : ID.STONE;
    if (e >= rock) return fbm(x * 0.15, y * 0.15, seed + 900, 2) > p.oreR ? ID.ORE : ID.SNOW;
    return fbm(x * 0.15, y * 0.15, seed + 900, 2) > p.oreR ? ID.ORE : ID.ROCK;
  }

  // legacy single-world helpers (map 0)
  function elevation(x, y) { return elevationFor(0, x, y); }
  function baseType(x, y) { return baseTypeFor(0, x, y); }

  // ---- chunks -------------------------------------------------------------
  function chunkOf(v) { return Math.floor(v / CHUNK); }

  function buildChunk(mapId, cx, cy) {
    var a = new Uint8Array(CHUNK * CHUNK);
    var x0 = cx * CHUNK, y0 = cy * CHUNK;
    for (var j = 0; j < CHUNK; j++)
      for (var i = 0; i < CHUNK; i++)
        a[j * CHUNK + i] = baseTypeFor(mapId, x0 + i, y0 + j);
    return a;
  }

  function sampleGrid(mapId, gw, gh) {
    var out = new Uint8Array(gw * gh);
    var sx = W / gw, sy = H / gh;
    for (var j = 0; j < gh; j++)
      for (var i = 0; i < gw; i++)
        out[j * gw + i] = baseTypeFor(mapId, Math.min(W - 1, (i * sx) | 0), Math.min(H - 1, (j * sy) | 0));
    return out;
  }

  function spawnPoint(mapId) {
    mapId = mapId | 0;
    var cx = W >> 1, cy = H >> 1;
    // Soft land first (first-glance trees); dirt/sand only as fallback.
    var SOFT = [ID.GRASS, ID.GRASSDARK];
    var HARD = [ID.DIRT, ID.SAND];
    var soft = null, hardTree = null, hard = null, fallback = null;
    function dryPad(x, y) {
      for (var dy = -2; dy <= 2; dy++)
        for (var dx = -2; dx <= 2; dx++) {
          var n = baseTypeFor(mapId, x + dx, y + dy);
          if (n === ID.WATER || n === ID.VOID) return false;
        }
      return true;
    }
    function hasTreeNear(x, y) {
      for (var dy = -12; dy <= 12; dy++)
        for (var dx = -12; dx <= 12; dx++) {
          if (dx * dx + dy * dy > 144) continue;
          if (nodeAt(mapId, x + dx, y + dy) === 'TREE') return true;
        }
      return false;
    }
    for (var r = 0; r < 320; r += 2) {
      for (var a = 0; a < 64; a++) {
        var t = (a / 64) * Math.PI * 2;
        var x = Math.round(cx + Math.cos(t) * r), y = Math.round(cy + Math.sin(t) * r);
        var b = baseTypeFor(mapId, x, y);
        if (b === ID.WATER || b === ID.VOID) continue;
        if (!fallback) fallback = { x: x, y: y };
        var isSoft = SOFT.indexOf(b) >= 0, isHard = HARD.indexOf(b) >= 0;
        if (!isSoft && !isHard) continue;
        if (!dryPad(x, y)) {
          if (isSoft && !soft) soft = { x: x, y: y };
          continue;
        }
        var nearTree = hasTreeNear(x, y);
        if (isSoft) {
          if (nearTree) return { x: x, y: y };
          if (!soft) soft = { x: x, y: y };
        } else {
          if (nearTree && !hardTree) hardTree = { x: x, y: y };
          if (!hard) hard = { x: x, y: y };
        }
      }
    }
    return hardTree || soft || hard || fallback || { x: cx, y: cy };
  }

  // ---- resource nodes -----------------------------------------------------
  // A node is a *provision of the world*, not a player's build: it is generated from
  // (map, x, y) and can therefore reset forever without anyone losing anything.
  var NODE_KINDS = {
    TREE: { id: 1, name: 'tree', yield: 'wood', yields: 'wood', amount: 2, respawnMs: 45000, hp: 3, form: 'trunk' },
    ORE: { id: 2, name: 'ore seam', yield: 'ore', yields: 'ore', amount: 2, respawnMs: 90000, hp: 4, form: 'vein' },
    HERB: { id: 3, name: 'herb', yield: 'herb', yields: 'herb', amount: 1, respawnMs: 30000, hp: 1, form: 'sprig' },
    CRYSTAL: { id: 4, name: 'crystal', yield: 'crystal', yields: 'crystal', amount: 1, respawnMs: 150000, hp: 2, form: 'shard' }
  };

  /** The node (if any) generated at this tile. Pure function — no state. */
  function nodeAt(mapId, x, y) {
    var def = mapDef(mapId), b = baseTypeFor(mapId, x, y), n = def.nodes;
    var salt = def.seed + 31337;
    if (b === ID.LEAVES && r01(x, y, salt + 1) < n.tree) return 'TREE';
    if (b === ID.ORE && r01(x, y, salt + 2) < n.ore) return 'ORE';
    if ((b === ID.GRASS || b === ID.GRASSDARK) && r01(x, y, salt + 3) < n.herb) return 'HERB';
    // crystal belongs to high rock only — never to ordinary surface stone
    if ((b === ID.ROCK || b === ID.SNOW) && r01(x, y, salt + 4) < n.crystal) return 'CRYSTAL';
    return null;
  }

  /** Nodes generated inside a chunk, as [[x,y,kindId], ...]. */
  function nodesInChunk(mapId, cx, cy) {
    var out = [], x0 = cx * CHUNK, y0 = cy * CHUNK;
    for (var j = 0; j < CHUNK; j++)
      for (var i = 0; i < CHUNK; i++) {
        var k = nodeAt(mapId, x0 + i, y0 + j);
        if (k) out.push([x0 + i, y0 + j, NODE_KINDS[k].id]);
      }
    return out;
  }

  function kindById(id) {
    for (var k in NODE_KINDS) if (NODE_KINDS[k].id === id) return k;
    return null;
  }

  // ---- combat & progression data ------------------------------------------
  /**
   * COMBAT MODEL — all of it data, all of it shared with the browser.
   *
   * A species is declared once, here, and read by the server (world.js runs the AI), by
   * the renderer (draws .form) and by the tests. Nothing about a creature is hidden in
   * code: if it isn't in this table it doesn't exist. Damage types, resistances, wind-up
   * timings and loot tables are all plain numbers so balance is a data edit.
   */
  var DAMAGE_TYPES = ['physical', 'fire', 'ice'];
  var DEFAULT_DMG_TYPE = 'physical';

  var COMBAT = {
    variance: 0.18,       // every blow lands within ±18% of the attacker's attack
    critChance: 0.25,     // the player's chance to land a critical hit
    critMul: 1.8,
    monCritChance: 0.12,  // monsters crit less often than you do
    monCritMul: 1.6,
    minDamage: 1,
    regenDelayMs: 12000   // untouched for this long and a wounded creature knits itself
  };

  // A monster's reset clock scales with its tier: losing a tier-3 tank should hurt.
  var TIER_RESPAWN_MUL = { 1: 1, 2: 1.4, 3: 1.9 };
  function respawnMsFor(sp) { return Math.round((sp.respawnMs || 60000) * (TIER_RESPAWN_MUL[sp.tier] || 1)); }

  /** Roll one blow: variance, then crit. Returns {dmg, crit}. */
  function damageRoll(atk, critChance, critMul) {
    var a = Math.max(1, +atk || 1);
    var cc = (critChance === undefined) ? COMBAT.critChance : critChance;
    var cm = (critMul === undefined) ? COMBAT.critMul : critMul;
    var v = 1 + (Math.random() * 2 - 1) * COMBAT.variance;
    var crit = Math.random() < cc;
    return { dmg: Math.max(COMBAT.minDamage, Math.round(a * v * (crit ? cm : 1))), crit: crit, atk: a };
  }

  /** Resistance of a defender (species OR player) to a damage type: -1 weak, +1 immune. */
  function resistOf(target, type) {
    if (!target || !target.resist) return 0;
    var r = target.resist[type];
    return (typeof r === 'number') ? r : 0;
  }
  function applyResist(type, amount, target) {
    var r = resistOf(target, type);
    if (r > 0.95) r = 0.95;
    if (r < -0.95) r = -0.95;
    return amount * (1 - r);
  }

  /** Roll a species' loot table: {grants:{item:qty}, primary, rolls}. `rand` is injectable. */
  function rollLoot(sp, rand) {
    var rnd = rand || Math.random;
    var table = (sp && sp.lootTable) || [];
    var grants = {}, primary = null, rolls = 0;
    for (var i = 0; i < table.length; i++) {
      var e = table[i];
      rolls++;
      var n = 0;
      if (rnd() < (e.chance === undefined ? 1 : e.chance)) {
        var mn = e.min === undefined ? 1 : e.min;
        var mx = e.max === undefined ? mn : e.max;
        n = mn + Math.floor(rnd() * (mx - mn + 1));
      }
      if (n > 0) { grants[e.item] = (grants[e.item] || 0) + n; if (!primary) primary = e.item; }
    }
    return { grants: grants, primary: primary, rolls: rolls };
  }

  // ---- player progression -------------------------------------------------
  /** Level curve. Max HP and attack are DERIVED from level, never stored. */
  var LEVEL = { max: 40, hpBase: 100, hpPer: 15, atkBase: 7, atkPerLevel: 0.5, xpBase: 30, xpGrowth: 1.6 };

  function xpToNext(level) { return Math.round(LEVEL.xpBase * Math.pow(LEVEL.xpGrowth, Math.max(0, (level | 0) - 1))); }
  function maxHpForLevel(level) { return LEVEL.hpBase + LEVEL.hpPer * (Math.max(1, level | 0) - 1); }
  function attackForLevel(level) { return LEVEL.atkBase + Math.floor((Math.max(1, level | 0) - 1) * LEVEL.atkPerLevel); }
  function levelFromXp(xp) {
    var total = Math.max(0, xp || 0), l = 1, rem = total;
    while (l < LEVEL.max && rem >= xpToNext(l)) { rem -= xpToNext(l); l++; }
    return { level: l, xp: total, into: rem, next: xpToNext(l) };
  }

  /** Non-reversible tag for a player key — safe to publish in /api/stats. */
  function keyTag(key) {
    var s = String(key || ''), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) | 0; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }

  function speciesOf(mapId, idx) {
    var list = SPECIES[mapId] || SPECIES[0];
    return list[idx] || list[0];
  }

  /** Generated monster homes within a chunk radius of a point: [{x,y,kind,sp}]. */
  function homesNear(mapId, x, y, chunkRadius) {
    var r = (chunkRadius === undefined) ? 3 : chunkRadius;
    var cx = chunkOf(x), cy = chunkOf(y), out = [];
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        var hx = cx + dx, hy = cy + dy;
        if (hx < 0 || hy < 0 || hx * CHUNK >= W || hy * CHUNK >= H) continue;
        var list = monstersInChunk(mapId, hx, hy);
        for (var i = 0; i < list.length; i++) {
          out.push({
            x: list[i][0] + 0.5, y: list[i][1] + 0.5, kind: list[i][2],
            sp: speciesOf(mapId, list[i][2])
          });
        }
      }
    }
    return out;
  }

  /**
   * Fill in every field a species must carry, so the tables below only spell out what is
   * interesting about each creature. Required on every entry: kind/name, form, tier,
   * hp, atk, speed, aggro, respawnMs (the renderer and the tests read these directly).
   */
  function sp(o) {
    o.name = o.kind;
    o.form = o.form || 'blob';
    o.tier = o.tier || 1;
    o.role = o.role || 'brute';
    o.dmgType = o.dmgType || DEFAULT_DMG_TYPE;
    o.resist = o.resist || {};
    o.windupMs = o.windupMs || 420;
    o.cooldownMs = o.cooldownMs || 1400;
    o.melee = o.melee || 1.7;
    o.xp = o.xp || 5;
    o.leash = o.leash || Math.max(14, Math.round(o.aggro * 1.6));
    if (!o.lootTable) o.lootTable = [{ item: o.loot, chance: 1, min: 1, max: 1 }];
    return o;
  }

  // ---- monsters -----------------------------------------------------------
  var SPECIES = {
    0: [ // THE FIRST ACRE — gentle
      // 0 kiter — keeps its distance and plinks you; hard to corner
      sp({ kind: 'MOSS_HOPPER', form: 'wisp', tier: 1, role: 'kiter',
        hp: 22, atk: 3, speed: 1.9, aggro: 7, respawnMs: 60000, xp: 5, loot: 'herb',
        dmgType: 'physical', resist: { physical: 0, fire: -0.25, ice: 0.2 },
        windupMs: 340, cooldownMs: 1500, ranged: 5, keepAway: 3.5, shootRange: 5,
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 2 }, { item: 'wood', chance: 0.25, min: 1, max: 1 }] }),
      // 1 charging brute — winds up, then barrels through you
      sp({ kind: 'THICKET_MAW', form: 'brute', tier: 1, role: 'brute',
        hp: 34, atk: 5, speed: 1.3, aggro: 9, respawnMs: 90000, xp: 12, loot: 'wood',
        dmgType: 'physical', resist: { physical: 0.15, fire: 0, ice: -0.2 },
        windupMs: 520, cooldownMs: 1800, melee: 1.6,
        charge: { range: 15, windupMs: 650, dashMs: 900, dashMul: 2.8, cooldownMs: 4200 },
        lootTable: [{ item: 'wood', chance: 1, min: 1, max: 3 }, { item: 'herb', chance: 0.2, min: 1, max: 1 }] }),
      // 2 fast swarmling — weak, quick, and always first to arrive
      sp({ kind: 'STONE_SKITTER', form: 'swarm', tier: 1, role: 'swarm',
        hp: 18, atk: 4, speed: 2.6, aggro: 8, respawnMs: 75000, xp: 6, loot: 'ore',
        dmgType: 'physical', resist: { physical: 0, fire: 0.25, ice: -0.2 },
        windupMs: 260, cooldownMs: 1000, melee: 1.5,
        lootTable: [{ item: 'ore', chance: 1, min: 1, max: 2 }, { item: 'crystal', chance: 0.08, min: 1, max: 1 }] }),
      // 3 slow high-HP tank — you cannot out-DPS it, you have to out-think it
      sp({ kind: 'BOULDERBACK', form: 'tank', tier: 2, role: 'tank',
        hp: 64, atk: 8, speed: 0.85, aggro: 7, respawnMs: 140000, xp: 26, loot: 'ore',
        dmgType: 'physical', resist: { physical: 0.35, fire: -0.1, ice: -0.15 },
        windupMs: 780, cooldownMs: 2400, melee: 1.8,
        lootTable: [{ item: 'ore', chance: 1, min: 1, max: 3 }, { item: 'crystal', chance: 0.3, min: 1, max: 2 }] }),
      // 4 pack hunter — screams, and its neighbours come
      sp({ kind: 'ACRE_RAT', form: 'hound', tier: 1, role: 'pack',
        hp: 26, atk: 4, speed: 2.1, aggro: 10, respawnMs: 70000, xp: 10, loot: 'herb',
        dmgType: 'physical', resist: { physical: 0, fire: -0.2, ice: 0 },
        windupMs: 300, cooldownMs: 1100, melee: 1.5,
        pack: { callRadius: 22, maxAllies: 3 },
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 2 }, { item: 'wood', chance: 0.15, min: 1, max: 1 }] })
    ],
    1: [ // ASHEN HOLLOW — hostile
      // 0 pack hunter — calls nearby CINDER_HOUNDs the moment it aggros
      sp({ kind: 'CINDER_HOUND', form: 'hound', tier: 2, role: 'pack',
        hp: 52, atk: 9, speed: 2.0, aggro: 12, respawnMs: 120000, xp: 30, loot: 'ore',
        dmgType: 'fire', resist: { physical: 0, fire: 0.6, ice: -0.35 },
        windupMs: 420, cooldownMs: 1300, melee: 1.6,
        pack: { callRadius: 26, maxAllies: 3 },
        lootTable: [{ item: 'ore', chance: 1, min: 1, max: 3 }, { item: 'crystal', chance: 0.2, min: 1, max: 1 }] }),
      // 1 tank — 96 HP, lava-blooded, and it knows it
      sp({ kind: 'SLAG_WRETCH', form: 'tank', tier: 3, role: 'tank',
        hp: 96, atk: 13, speed: 0.9, aggro: 10, respawnMs: 180000, xp: 60, loot: 'crystal',
        dmgType: 'fire', resist: { physical: 0.3, fire: 0.85, ice: -0.4 },
        windupMs: 800, cooldownMs: 2400, melee: 1.8,
        lootTable: [{ item: 'crystal', chance: 1, min: 1, max: 2 }, { item: 'ore', chance: 0.6, min: 1, max: 4 }] }),
      // 2 spitter — burns you from nine tiles out
      sp({ kind: 'ASH_SPITTER', form: 'spitter', tier: 2, role: 'spitter',
        hp: 40, atk: 7, speed: 1.1, aggro: 13, respawnMs: 110000, xp: 20, loot: 'herb',
        dmgType: 'fire', resist: { physical: 0, fire: 0.5, ice: -0.3 },
        windupMs: 620, cooldownMs: 1900, ranged: 9, keepAway: 6, shootRange: 10,
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 2 }, { item: 'ore', chance: 0.4, min: 1, max: 2 }] }),
      // 3 swarmling — arrives in a pack's worth of noise, dies in two hits
      sp({ kind: 'EMBER_SWARMLING', form: 'swarm', tier: 2, role: 'swarm',
        hp: 22, atk: 5, speed: 2.8, aggro: 11, respawnMs: 80000, xp: 9, loot: 'ore',
        dmgType: 'fire', resist: { physical: 0, fire: 0.4, ice: -0.3 },
        windupMs: 240, cooldownMs: 950, melee: 1.5,
        lootTable: [{ item: 'ore', chance: 1, min: 1, max: 2 }, { item: 'crystal', chance: 0.12, min: 1, max: 1 }] })
    ],
    2: [ // THE SUNKEN SHELF — amphibious
      // 0 kiter — amphibious skirmisher; dances out of melee range
      sp({ kind: 'BRINE_LURKER', form: 'wisp', tier: 2, role: 'kiter',
        hp: 44, atk: 7, speed: 1.7, aggro: 11, respawnMs: 100000, xp: 15, loot: 'herb',
        dmgType: 'ice', resist: { physical: 0, fire: -0.3, ice: 0.6 },
        windupMs: 400, cooldownMs: 1600, ranged: 6, keepAway: 5, shootRange: 8,
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 2 }, { item: 'crystal', chance: 0.2, min: 1, max: 1 }] }),
      // 1 tank — armoured, patient, and worth real XP
      sp({ kind: 'SHELL_BRUTE', form: 'tank', tier: 3, role: 'tank',
        hp: 84, atk: 11, speed: 0.95, aggro: 8, respawnMs: 150000, xp: 45, loot: 'crystal',
        dmgType: 'physical', resist: { physical: 0.4, fire: 0, ice: 0.2 },
        windupMs: 700, cooldownMs: 2200, melee: 1.8,
        lootTable: [{ item: 'crystal', chance: 1, min: 1, max: 2 }, { item: 'herb', chance: 0.5, min: 1, max: 3 }] }),
      // 2 spitter — spits ice from ten tiles out, so the shore is not safe
      sp({ kind: 'SALT_SPITTER', form: 'spitter', tier: 2, role: 'spitter',
        hp: 38, atk: 8, speed: 1.2, aggro: 14, respawnMs: 120000, xp: 22, loot: 'herb',
        dmgType: 'ice', resist: { physical: 0, fire: -0.3, ice: 0.5 },
        windupMs: 640, cooldownMs: 2000, ranged: 10, keepAway: 6, shootRange: 11,
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 2 }, { item: 'ore', chance: 0.45, min: 1, max: 2 }] }),
      // 3 swarmling — the fastest thing on the shelf
      sp({ kind: 'TIDE_SWARMLING', form: 'swarm', tier: 2, role: 'swarm',
        hp: 20, atk: 5, speed: 3.0, aggro: 12, respawnMs: 70000, xp: 8, loot: 'herb',
        dmgType: 'ice', resist: { physical: 0, fire: -0.2, ice: 0.4 },
        windupMs: 220, cooldownMs: 900, melee: 1.5,
        lootTable: [{ item: 'herb', chance: 1, min: 1, max: 3 }, { item: 'ore', chance: 0.2, min: 1, max: 1 }] })
    ]
  };

  /** Monster home points generated inside a chunk — [[x,y,speciesIdx], ...]. */
  function monstersInChunk(mapId, cx, cy) {
    var list = SPECIES[mapId] || SPECIES[0];
    var salt = mapDef(mapId).seed + 777;
    var out = [], x0 = cx * CHUNK, y0 = cy * CHUNK;
    for (var j = 0; j < CHUNK; j++) {
      for (var i = 0; i < CHUNK; i++) {
        var x = x0 + i, y = y0 + j;
        var h = r01(x, y, salt);
        if (h > 0.0009) continue;                      // ~1 home per 1,100 tiles
        var b = baseTypeFor(mapId, x, y);
        if (b === ID.WATER || b === ID.VOID) continue;
        var pick = Math.floor(r01(x, y, salt + 5) * list.length) % list.length;
        out.push([x, y, pick]);
      }
    }
    return out;
  }

  return {
    W: W, H: H, CHUNK: CHUNK, BORDER: BORDER, SEED: MAP0.seed,
    ID: ID, PALETTE: PALETTE, MAPS: MAPS, NODE_KINDS: NODE_KINDS, SPECIES: SPECIES,
    DAMAGE_TYPES: DAMAGE_TYPES, DEFAULT_DMG_TYPE: DEFAULT_DMG_TYPE,
    COMBAT: COMBAT, LEVEL: LEVEL, TIER_RESPAWN_MUL: TIER_RESPAWN_MUL,
    isPlaceable: isPlaceable, mapDef: mapDef, toneOf: toneOf, kindById: kindById,
    hash2: hash2, r01: r01, fbm: fbm,
    elevation: elevation, elevationFor: elevationFor,
    baseType: baseType, baseTypeFor: baseTypeFor,
    chunkOf: chunkOf, buildChunk: buildChunk, sampleGrid: sampleGrid,
    spawnPoint: spawnPoint, nodeAt: nodeAt, nodesInChunk: nodesInChunk,
    monstersInChunk: monstersInChunk, homesNear: homesNear, speciesOf: speciesOf,
    respawnMsFor: respawnMsFor, damageRoll: damageRoll,
    resistOf: resistOf, applyResist: applyResist, rollLoot: rollLoot,
    xpToNext: xpToNext, maxHpForLevel: maxHpForLevel, attackForLevel: attackForLevel,
    levelFromXp: levelFromXp, keyTag: keyTag
  };
});
