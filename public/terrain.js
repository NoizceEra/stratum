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
  var MAPS = [
    {
      id: 0, name: 'THE FIRST ACRE', tier: 1, seed: 1337,
      desc: 'Verdant and open. Where everyone starts and everything is built.',
      params: { water: 0.30, ridge: 0.50, scale: 0.010, tree: 0.70, moist: 0.53, ore: 0.72, oreR: 0.78 },
      nodes: { tree: 0.20, ore: 0.30, herb: 0.012, crystal: 0.004 }
    },
    {
      id: 1, name: 'ASHEN HOLLOW', tier: 2, seed: 4242,
      desc: 'Broken rock and shallow soil. Almost nothing grows; everything is under it.',
      params: { water: 0.24, ridge: 0.74, scale: 0.013, tree: 0.97, moist: 0.80, ore: 0.58, oreR: 0.62 },
      nodes: { tree: 0.02, ore: 0.07, herb: 0.010, crystal: 0.010 }
    },
    {
      id: 2, name: 'THE SUNKEN SHELF', tier: 2, seed: 9001,
      desc: 'Islands, shallows and salt. Land is scarce here, and contested.',
      params: { water: 0.52, ridge: 0.26, scale: 0.016, tree: 0.45, moist: 0.45, ore: 0.70, oreR: 0.72 },
      nodes: { tree: 0.02, ore: 0.35, herb: 0.030, crystal: 0.030 }
    }
  ];
  var MAP0 = MAPS[0];
  function mapDef(id) { return MAPS[id] || MAP0; }

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
    var PREFER = [ID.GRASS, ID.GRASSDARK, ID.DIRT, ID.SAND];
    var sponsor = null, fallback = null;
    for (var r = 0; r < 320; r += 2) {
      for (var a = 0; a < 64; a++) {
        var t = (a / 64) * Math.PI * 2;
        var x = Math.round(cx + Math.cos(t) * r), y = Math.round(cy + Math.sin(t) * r);
        var b = baseTypeFor(mapId, x, y);
        if (b === ID.WATER || b === ID.VOID) continue;
        if (!fallback) fallback = { x: x, y: y };
        if (PREFER.indexOf(b) >= 0) {
          var ok = true;
          for (var dy = -2; dy <= 2 && ok; dy++)
            for (var dx = -2; dx <= 2; dx++) {
              var n = baseTypeFor(mapId, x + dx, y + dy);
              if (n === ID.WATER || n === ID.VOID) { ok = false; break; }
            }
          if (ok) return { x: x, y: y };
          if (!sponsor) sponsor = { x: x, y: y };
        }
      }
    }
    return sponsor || fallback || { x: cx, y: cy };
  }

  // ---- resource nodes -----------------------------------------------------
  // A node is a *provision of the world*, not a player's build: it is generated from
  // (map, x, y) and can therefore reset forever without anyone losing anything.
  var NODE_KINDS = {
    TREE: { id: 1, name: 'tree', yields: 'wood', amount: 2, respawnMs: 45000, hp: 3 },
    ORE: { id: 2, name: 'ore seam', yields: 'ore', amount: 2, respawnMs: 90000, hp: 4 },
    HERB: { id: 3, name: 'herb', yields: 'herb', amount: 1, respawnMs: 30000, hp: 1 },
    CRYSTAL: { id: 4, name: 'crystal', yields: 'crystal', amount: 1, respawnMs: 150000, hp: 2 }
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

  // ---- monsters -----------------------------------------------------------
  var SPECIES = {
    0: [ // THE FIRST ACRE — gentle
      { kind: 'MOSS_HOPPER', hp: 22, atk: 3, respawnMs: 60000, speed: 1.1, aggro: 7, xp: 4, loot: 'herb' },
      { kind: 'THICKET_MAW', hp: 34, atk: 5, respawnMs: 90000, speed: 1.3, aggro: 9, xp: 7, loot: 'wood' },
      { kind: 'STONE_SKITTER', hp: 28, atk: 4, respawnMs: 75000, speed: 1.8, aggro: 8, xp: 6, loot: 'ore' }
    ],
    1: [ // ASHEN HOLLOW — hostile
      { kind: 'CINDER_HOUND', hp: 52, atk: 9, respawnMs: 120000, speed: 2.0, aggro: 12, xp: 16, loot: 'ore' },
      { kind: 'SLAG_WRETCH', hp: 78, atk: 13, respawnMs: 180000, speed: 1.2, aggro: 10, xp: 24, loot: 'crystal' }
    ],
    2: [ // THE SUNKEN SHELF — amphibious
      { kind: 'BRINE_LURKER', hp: 44, atk: 7, respawnMs: 100000, speed: 1.6, aggro: 11, xp: 13, loot: 'herb' },
      { kind: 'SHELL_BRUTE', hp: 66, atk: 11, respawnMs: 150000, speed: 1.0, aggro: 8, xp: 20, loot: 'crystal' }
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
    isPlaceable: isPlaceable, mapDef: mapDef, kindById: kindById,
    hash2: hash2, r01: r01, fbm: fbm,
    elevation: elevation, elevationFor: elevationFor,
    baseType: baseType, baseTypeFor: baseTypeFor,
    chunkOf: chunkOf, buildChunk: buildChunk, sampleGrid: sampleGrid,
    spawnPoint: spawnPoint, nodeAt: nodeAt, nodesInChunk: nodesInChunk,
    monstersInChunk: monstersInChunk
  };
});
