/**
 * economy.js — the crafting / progression economy for STRATUM.
 *
 * WHY THIS FILE EXISTS
 *   The world hands out 10 build materials for energy ('will') alone, and the volatile
 *   layer hands out wood / ore / herb / crystal that had nowhere to go. This module is
 *   the sink: placing a tile now costs harvested resources, and tools, weapons and
 *   armour are crafted out of them.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Economy = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - Resource names and node yields mirror public/terrain.js NODE_KINDS; the repo's
 *     test-economy.js cross-checks them against that file so the two cannot drift.
 *
 * Inventories are flat plain objects — exactly the shape the server already keeps in
 * `client.inv` ({ wood: 0, ore: 0, herb: 0, crystal: 0 }) — with crafted item ids able
 * to sit alongside the raw resources.
 */
(function (root, factory) {
  // UMD: Node gets module.exports, a plain <script> gets window.Economy. Nothing else.
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Economy = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ======================================================================
  // basics
  // ======================================================================

  /** The four harvested resources, in the order the HUD shows them. */
  var RESOURCES = ['wood', 'ore', 'herb', 'crystal'];

  /** True for a finite integer (0 included); used to reject garbage input. */
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /** Recursively freeze a value so no caller can reach into a shared table. */
  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  /** Shallow copy of a cost/recipe-amount object (always a new object, never frozen). */
  function copyAmounts(o) {
    var out = {};
    if (o && typeof o === 'object') {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    }
    return out;
  }

  /** Copy an inventory, preserving unknown keys, without touching the original. */
  function cloneInv(inv) {
    var out = {};
    if (inv && typeof inv === 'object') {
      for (var k in inv) if (Object.prototype.hasOwnProperty.call(inv, k)) out[k] = inv[k];
    }
    return out;
  }

  /** How many of `key` an inventory holds; absent / negative / NaN all read as 0. */
  function held(inv, key) {
    var v = inv ? inv[key] : 0;
    return (isInt(v) && v > 0) ? v : 0;
  }

  // ======================================================================
  // 1. material cost table — the resource sink for placing tiles
  // ======================================================================

  /**
   * What each of the four node kinds actually gives per harvest — a mirror of
   * terrain.js NODE_KINDS, kept here so this module stays dependency-free.
   */
  var NODE_YIELDS = deepFreeze({
    TREE: { id: 1, resource: 'wood', amount: 2, hp: 3, respawnMs: 45000 },
    ORE: { id: 2, resource: 'ore', amount: 2, hp: 4, respawnMs: 90000 },
    HERB: { id: 3, resource: 'herb', amount: 1, hp: 1, respawnMs: 30000 },
    CRYSTAL: { id: 4, resource: 'crystal', amount: 1, hp: 2, respawnMs: 150000 }
  });

  /** How many harvests of one node a single cost entry is allowed to demand. */
  var MAX_HARVESTS = 4;

  /**
   * The durable build palette, index 0..9, matching terrain.js PALETTE
   * [DIRT, GRASS, STONE, SAND, WATER, WOOD, BRICK, GLASS, PATH, LAMP].
   */
  var MATERIAL_IDS = deepFreeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  /** Display names for the palette, index 0..9 (index 4 = 'water' is the odd one out). */
  var MATERIAL_NAMES = deepFreeze([
    'dirt', 'grass', 'stone', 'sand', 'water',
    'wood', 'brick', 'glass', 'path', 'lamp'
  ]);

  /**
   * MATERIAL_COSTS[i] = the harvested resources spent placing palette material i.
   * Every amount is reachable in a handful of harvests of the node that drops it
   * (wood: 2/harvest, ore: 2/harvest, herb: 1/harvest, crystal: 1/harvest).
   * 'will' energy is NOT modelled here — the caller still pays that separately.
   */
  var MATERIAL_COSTS = deepFreeze([
    { wood: 1 },                 // 0 dirt   — a wooden spade's worth
    { herb: 1 },                 // 1 grass  — seed sod
    { wood: 1, ore: 1 },         // 2 stone  — braced quarry block
    { wood: 1 },                 // 3 sand   — hauling planks
    { wood: 2 },                 // 4 water  — a sealed trough
    { wood: 3 },                 // 5 wood   — the platform itself
    { wood: 2, ore: 2 },         // 6 brick  — clay frame + fired ore
    { wood: 2, ore: 1 },         // 7 glass  — kiln fuel + silicates
    { wood: 1, ore: 1 },         // 8 path   — bedded gravel
    { wood: 1, ore: 1, crystal: 1 } // 9 lamp — a caged crystal core
  ]);

  /** The resource cost of palette material `materialIndex` (0..9), or null if out of range. */
  function costOf(materialIndex) {
    if (!isInt(materialIndex) || materialIndex < 0 || materialIndex >= MATERIAL_COSTS.length) return null;
    return copyAmounts(MATERIAL_COSTS[materialIndex]);
  }

  /** The cost of placing terrain tile id (1..10), mapping id -> palette index, or null. */
  function costOfTile(tileId) {
    var idx = MATERIAL_IDS.indexOf(tileId);
    return idx < 0 ? null : costOf(idx);
  }

  // ======================================================================
  // 2. tool tiers — flint -> copper -> iron -> steel
  // ======================================================================

  /** How hard each node kind is to work: better tools pay off more on hard nodes. */
  var NODE_HARDNESS = deepFreeze({ TREE: 0, ORE: 1, HERB: 0, CRYSTAL: 2 });

  /** Yield lost per hardness step — scales a tier's bonus down on stubborn nodes. */
  var HARDNESS_PENALTY = 0.15;

  /** Tool tiers in unlock order; each is gated by the resource cost of the next one. */
  var TOOL_TIERS = deepFreeze([
    { tier: 0, id: 'flint', name: 'flint', yieldMul: 1.00, speedMul: 1.00, cost: { wood: 2 } },
    { tier: 1, id: 'copper', name: 'copper', yieldMul: 1.25, speedMul: 1.15, cost: { wood: 3, ore: 2 } },
    { tier: 2, id: 'iron', name: 'iron', yieldMul: 1.50, speedMul: 1.35, cost: { wood: 2, ore: 5 } },
    { tier: 3, id: 'steel', name: 'steel', yieldMul: 2.00, speedMul: 1.60, cost: { ore: 8, crystal: 3 } }
  ]);

  /** The tool-tier record for `tier` (0..3), or null if there is no such tier. */
  function toolTier(tier) {
    return (isInt(tier) && tier >= 0 && tier < TOOL_TIERS.length) ? TOOL_TIERS[tier] : null;
  }

  /** The highest tool tier index (3 = steel). */
  function maxToolTier() { return TOOL_TIERS.length - 1; }

  /** The resource cost of unlocking `tier`, as a fresh object, or null if no such tier. */
  function toolCost(tier) {
    var t = toolTier(tier);
    return t ? copyAmounts(t.cost) : null;
  }

  /** Normalise a node kind given as 'TREE' / 'tree' / 1 into its UPPER_CASE key, or null. */
  function nodeKey(nodeKind) {
    if (typeof nodeKind === 'string') {
      var up = nodeKind.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(NODE_YIELDS, up)) return up;
      for (var k in NODE_YIELDS) if (NODE_YIELDS[k].resource === up) return k;
      return null;
    }
    if (isInt(nodeKind)) {
      for (var j in NODE_YIELDS) if (NODE_YIELDS[j].id === nodeKind) return j;
    }
    return null;
  }

  /** Harvest yield multiplier of tool `tier` on `nodeKind`; strictly rises with tier. */
  function toolYield(tier, nodeKind) {
    var t = toolTier(tier);
    if (!t) return null;
    var key = nodeKey(nodeKind);
    var hardness = key ? NODE_HARDNESS[key] : 0;
    return t.yieldMul * (1 - HARDNESS_PENALTY * hardness);
  }

  /** Harvest speed multiplier of tool `tier` (iterations per tick); strictly rises with tier. */
  function toolSpeed(tier) {
    var t = toolTier(tier);
    return t ? t.speedMul : null;
  }

  /** Whole units one harvest of `nodeKind` gives with tool `tier` (never below 1), or null. */
  function toolHarvestAmount(tier, nodeKind) {
    var mul = toolYield(tier, nodeKind);
    if (mul === null) return null;
    var key = nodeKey(nodeKind);
    var base = key ? NODE_YIELDS[key].amount : 1;
    return Math.max(1, Math.floor(base * mul));
  }

  // ======================================================================
  // 3. crafted items + recipes
  // ======================================================================

  /** Default stack ceiling for anything not listed in STACK_LIMITS. */
  var DEFAULT_STACK = 20;

  /** Everything craftable: weapons give damageBonus, armour gives mitigation. */
  var ITEMS = deepFreeze({
    flint_dagger: { id: 'flint_dagger', name: 'flint dagger', kind: 'weapon', tier: 0, damageBonus: 3, mitigation: 0, stack: 10 },
    copper_sword: { id: 'copper_sword', name: 'copper sword', kind: 'weapon', tier: 1, damageBonus: 7, mitigation: 0, stack: 10 },
    iron_axe: { id: 'iron_axe', name: 'iron axe', kind: 'weapon', tier: 2, damageBonus: 12, mitigation: 0, stack: 10 },
    steel_blade: { id: 'steel_blade', name: 'steel blade', kind: 'weapon', tier: 3, damageBonus: 18, mitigation: 0, stack: 10 },
    hide_vest: { id: 'hide_vest', name: 'hide vest', kind: 'armour', tier: 0, damageBonus: 0, mitigation: 2, stack: 10 },
    copper_plate: { id: 'copper_plate', name: 'copper plate', kind: 'armour', tier: 1, damageBonus: 0, mitigation: 5, stack: 10 },
    iron_mail: { id: 'iron_mail', name: 'iron mail', kind: 'armour', tier: 2, damageBonus: 0, mitigation: 9, stack: 10 },
    steel_aegis: { id: 'steel_aegis', name: 'steel aegis', kind: 'armour', tier: 3, damageBonus: 0, mitigation: 14, stack: 10 },

    // ---- cozy decor (ROADMAP_COZY.md §3) -----------------------------------
    // Furniture/decor for a claimed plot. Placing these on the world grid the way
    // build materials go down (T.PALETTE) would mean new tile ids, client renderer
    // work and a placement protocol of their own — real scope beyond this pass, so
    // for now they are craftable-but-not-yet-placeable inventory keepsakes, same as
    // any other crafted item, ready for a placement system to pick up later without
    // any of THIS data needing to change shape.
    garden_bench: { id: 'garden_bench', name: 'garden bench', kind: 'decor', tier: 0, damageBonus: 0, mitigation: 0, stack: 10 },
    planter_box: { id: 'planter_box', name: 'planter box', kind: 'decor', tier: 0, damageBonus: 0, mitigation: 0, stack: 10 },
    lantern_post: { id: 'lantern_post', name: 'lantern post', kind: 'decor', tier: 1, damageBonus: 0, mitigation: 0, stack: 10 }
  });

  /**
   * Crafting recipes. `inputs` are raw resources, `output` names exactly what lands in
   * the inventory. `tier` is the tool tier that unlocks the recipe (see recipesForTier).
   */
  var RECIPES = deepFreeze([
    { id: 'r_flint_dagger', output: { item: 'flint_dagger', count: 1 }, inputs: { wood: 2, ore: 1 }, tier: 0 },
    { id: 'r_hide_vest', output: { item: 'hide_vest', count: 1 }, inputs: { wood: 2, herb: 2 }, tier: 0 },
    { id: 'r_copper_sword', output: { item: 'copper_sword', count: 1 }, inputs: { wood: 3, ore: 3 }, tier: 1 },
    { id: 'r_copper_plate', output: { item: 'copper_plate', count: 1 }, inputs: { ore: 4, herb: 2 }, tier: 1 },
    { id: 'r_iron_axe', output: { item: 'iron_axe', count: 1 }, inputs: { wood: 4, ore: 5, herb: 2 }, tier: 2 },
    { id: 'r_iron_mail', output: { item: 'iron_mail', count: 1 }, inputs: { wood: 3, ore: 6 }, tier: 2 },
    { id: 'r_steel_blade', output: { item: 'steel_blade', count: 1 }, inputs: { wood: 4, ore: 7, crystal: 3 }, tier: 3 },
    { id: 'r_steel_aegis', output: { item: 'steel_aegis', count: 1 }, inputs: { ore: 8, herb: 3, crystal: 4 }, tier: 3 },

    // ---- cozy decor (ROADMAP_COZY.md §3) -----------------------------------
    { id: 'r_garden_bench', output: { item: 'garden_bench', count: 1 }, inputs: { wood: 3, herb: 1 }, tier: 0 },
    { id: 'r_planter_box', output: { item: 'planter_box', count: 1 }, inputs: { wood: 2, herb: 2 }, tier: 0 },
    { id: 'r_lantern_post', output: { item: 'lantern_post', count: 1 }, inputs: { wood: 2, ore: 2, crystal: 1 }, tier: 1 }
  ]);

  /** The recipe with this id, or null. */
  function recipeById(recipeId) {
    for (var i = 0; i < RECIPES.length; i++) if (RECIPES[i].id === recipeId) return RECIPES[i];
    return null;
  }

  /** What a recipe costs to make, as a fresh inputs object, or null for an unknown id. */
  function recipeCost(recipeId) {
    var r = recipeById(recipeId);
    return r ? copyAmounts(r.inputs) : null;
  }

  /** Every recipe unlocked at tool `tier` (its own tier and below); [] if the tier is bogus. */
  function recipesForTier(tier) {
    if (!isInt(tier)) return [];
    var out = [];
    for (var i = 0; i < RECIPES.length; i++) if (RECIPES[i].tier <= tier) out.push(RECIPES[i]);
    return out;
  }

  /** The item definition an inventory key refers to, or null if it is not a crafted item. */
  function itemOf(itemId) {
    return Object.prototype.hasOwnProperty.call(ITEMS, itemId) ? ITEMS[itemId] : null;
  }

  // ======================================================================
  // 4. inventory model
  // ======================================================================

  /** Per-resource stack ceilings; crafted items use their ITEMS[].stack value. */
  var STACK_LIMITS = deepFreeze({ wood: 400, ore: 400, herb: 200, crystal: 100 });

  /** How many of `key` fit in one stack: resource limit, item stack, else DEFAULT_STACK. */
  function stackLimit(key) {
    if (typeof key !== 'string' || key === '') return 0;
    if (Object.prototype.hasOwnProperty.call(STACK_LIMITS, key)) return STACK_LIMITS[key];
    var it = itemOf(key);
    return it ? it.stack : DEFAULT_STACK;
  }

  /** A NEW inventory with `key` raised by `n`, clamped to its stack limit; null on bad args. */
  function add(inv, key, n) {
    if (typeof key !== 'string' || key === '' || !isInt(n) || n < 0) return null;
    var out = cloneInv(inv);
    var limit = stackLimit(key);
    out[key] = Math.min(limit, held(inv, key) + n);
    return out;
  }

  /** A NEW inventory with `key` lowered by `n`, never below zero; null on bad args. */
  function remove(inv, key, n) {
    if (typeof key !== 'string' || key === '' || !isInt(n) || n < 0) return null;
    var out = cloneInv(inv);
    out[key] = Math.max(0, held(inv, key) - n);
    return out;
  }

  /** Free room left in `key`'s stack given `inv` (limit minus what is held). */
  function roomFor(inv, key) { return Math.max(0, stackLimit(key) - held(inv, key)); }

  /** { ok, errors } — flags negative/non-integer balances and stacks over their limit. */
  function validate(inv) {
    var errors = [];
    if (!inv || typeof inv !== 'object') return { ok: false, errors: ['inventory is not an object'] };
    for (var k in inv) {
      if (!Object.prototype.hasOwnProperty.call(inv, k)) continue;
      var v = inv[k];
      if (!isInt(v)) errors.push(k + ' is not an integer');
      else if (v < 0) errors.push(k + ' is negative');
      else if (v > stackLimit(k)) errors.push(k + ' exceeds stack limit ' + stackLimit(k));
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /** An empty inventory carrying every raw resource (and any extra keys) at 0. */
  function emptyInv(extraKeys) {
    var out = {};
    for (var i = 0; i < RESOURCES.length; i++) out[RESOURCES[i]] = 0;
    if (extraKeys && typeof extraKeys === 'object') {
      for (var k in extraKeys) if (Object.prototype.hasOwnProperty.call(extraKeys, k)) out[k] = 0;
    }
    return out;
  }

  // ======================================================================
  // 5. costs against an inventory — all pure
  // ======================================================================

  /** True if `inv` can pay every positive entry of `cost`; false for a malformed cost. */
  function canAfford(inv, cost) {
    if (!cost || typeof cost !== 'object') return false;
    for (var k in cost) {
      if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
      var need = cost[k];
      if (!isInt(need) || need <= 0) continue;
      if (held(inv, k) < need) return false;
    }
    return true;
  }

  /** What `inv` is short of for `cost`, as { resource: shortfall }; {} when affordable. */
  function missingFor(inv, cost) {
    var out = {};
    if (!cost || typeof cost !== 'object') return out;
    for (var k in cost) {
      if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
      var need = cost[k];
      if (!isInt(need) || need <= 0) continue;
      var gap = need - held(inv, k);
      if (gap > 0) out[k] = gap;
    }
    return out;
  }

  /** A NEW inventory with `cost` deducted; null (input untouched) if it cannot be paid. */
  function applyCost(inv, cost) {
    if (!canAfford(inv, cost)) return null;
    var out = cloneInv(inv);
    for (var k in cost) {
      if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
      var need = cost[k];
      if (!isInt(need) || need <= 0) continue;
      var left = held(inv, k) - need;
      out[k] = left > 0 ? left : 0;
    }
    return out;
  }

  // ======================================================================
  // 6. crafting
  // ======================================================================

  /** Uniform craft failure: ok:false, a reason, and the input inventory returned untouched. */
  function craftFail(inv, error) {
    return { ok: false, error: error, item: null, count: 0, outputs: null, inv: inv };
  }

  /**
   * Craft `recipeId` from `inv`. Returns { ok:true, item, count, outputs, recipe, inv } with
   * `inv` a NEW inventory, or { ok:false, error, inv: <the argument, unmodified> }. Never
   * throws, never mutates, and fails cleanly when inputs are short or the stack is full.
   */
  function craft(recipeId, inv) {
    var r = recipeById(recipeId);
    if (!r) return craftFail(inv, 'unknown recipe: ' + recipeId);
    if (!canAfford(inv, r.inputs)) {
      var miss = missingFor(inv, r.inputs), parts = [];
      for (var m in miss) parts.push(m + ' ' + miss[m]);
      return craftFail(inv, 'insufficient resources: ' + parts.join(', '));
    }
    var paid = applyCost(inv, r.inputs);
    if (!paid) return craftFail(inv, 'insufficient resources');
    var room = roomFor(paid, r.output.item);
    if (room < r.output.count) return craftFail(inv, 'stack limit reached for ' + r.output.item);
    paid[r.output.item] = held(paid, r.output.item) + r.output.count;
    return {
      ok: true, error: null, recipe: r.id, item: r.output.item, count: r.output.count,
      outputs: (function () { var o = {}; o[r.output.item] = r.output.count; return o; })(),
      inv: paid
    };
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    // ---- world / palette --------------------------------------------------
    RESOURCES: RESOURCES,                 // the four harvestable resource names.
    MATERIAL_IDS: MATERIAL_IDS,           // terrain tile ids of the 10 build materials (index-aligned).
    MATERIAL_NAMES: MATERIAL_NAMES,       // display names for the 10 build materials.
    MATERIAL_COSTS: MATERIAL_COSTS,       // cost table: index 0..9 -> { resource: amount }.
    NODE_YIELDS: NODE_YIELDS,             // what each node kind drops per harvest (mirror of terrain.js).
    MAX_HARVESTS: MAX_HARVESTS,           // harvests a single cost entry may demand (affordability ceiling).
    costOf: costOf,                       // cost of palette material 0..9 as a fresh object, or null.
    costOfTile: costOfTile,               // cost of a terrain tile id (1..10) as a fresh object, or null.

    // ---- tools ------------------------------------------------------------
    TOOL_TIERS: TOOL_TIERS,               // the flint/copper/iron/steel tier table.
    NODE_HARDNESS: NODE_HARDNESS,         // per-node-kind hardness used to scale tool yield.
    HARDNESS_PENALTY: HARDNESS_PENALTY,   // yield lost per hardness step.
    toolTier: toolTier,                   // the tier record for a tier index, or null.
    maxToolTier: maxToolTier,             // index of the best tier (steel).
    toolCost: toolCost,                   // resource cost of unlocking a tier, or null.
    toolYield: toolYield,                 // yield multiplier of (tier, nodeKind); rises with tier.
    toolSpeed: toolSpeed,                 // speed multiplier of a tier; rises with tier.
    toolHarvestAmount: toolHarvestAmount, // whole units one harvest gives (>=1), or null.
    nodeKey: nodeKey,                     // normalise 'TREE'/'tree'/1 to 'TREE', or null.

    // ---- items and recipes ------------------------------------------------
    ITEMS: ITEMS,                         // every crafted item: weapons damage, armour mitigation.
    RECIPES: RECIPES,                     // every recipe, each with a unique id, inputs and output.
    recipeById: recipeById,               // recipe lookup by id, or null.
    recipeCost: recipeCost,               // resource cost of the recipe behind an id, or null.
    recipesForTier: recipesForTier,       // recipes unlocked at a tool tier (tier and below).
    itemOf: itemOf,                       // item definition for an inventory key, or null.
    craft: craft,                         // craft a recipe: pure, never throws, never mutates.

    // ---- inventory --------------------------------------------------------
    STACK_LIMITS: STACK_LIMITS,           // per-resource stack ceilings.
    DEFAULT_STACK: DEFAULT_STACK,         // stack ceiling for unlisted keys.
    stackLimit: stackLimit,               // stack ceiling for any inventory key.
    emptyInv: emptyInv,                   // a fresh inventory with every resource at 0.
    add: add,                             // NEW inventory with a key raised, clamped to its limit.
    remove: remove,                       // NEW inventory with a key lowered, never below zero.
    roomFor: roomFor,                     // free space left in a key's stack.
    validate: validate,                   // { ok, errors } for balances and stack overflows.

    // ---- costs ------------------------------------------------------------
    canAfford: canAfford,                 // can this inventory pay this cost?
    missingFor: missingFor,               // shortfall per resource for a cost ({ } if affordable).
    applyCost: applyCost                  // NEW inventory with the cost deducted, or null if unaffordable.
  };
});
