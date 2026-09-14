/**
 * test-economy.js — assertions for src/economy.js (STRATUM's crafting economy).
 *
 * Zero dependencies: Node stdlib only (fs, path, vm) plus the repo's own terrain.js,
 * because the whole point of the economy is that its costs and recipes are payable
 * with what real resource nodes actually drop — so it is validated against that file
 * rather than against a copy of my own assumptions.
 *
 * Prints PASS/FAIL per case and exits non-zero if anything fails.
 *
 *   node test-economy.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const T = require('./public/terrain.js');            // real node kinds / yields (read-only)
const Eco = require('./src/economy.js');             // the module under test
const SRC = fs.readFileSync(path.join(__dirname, 'src', 'economy.js'), 'utf8');
/** Source with comments stripped — scanning prose for require() gives false positives. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;

function t(name, fn) {
  let ok = true, err = null;
  try { fn(); } catch (e) { err = e; }
  if (err) { ok = false; console.log('FAIL  ' + name + '\n        ' + (err && err.message)); }
  else console.log('PASS  ' + name);
  ok ? passed++ : failed++;
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/** Canonical JSON: key order independent, so deep equality is real equality. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function eq(a, b, msg) { assert(canon(a) === canon(b), (msg || 'not equal') + ': ' + canon(a) + ' !== ' + canon(b)); }
function keyCount(o) { return Object.keys(o).filter(k => canon(o[k]) !== '0').length; }

// ---------------------------------------------------------------------------
// ground truth from terrain.js
// ---------------------------------------------------------------------------
const NODES = T.NODE_KINDS || {};
const realAmount = {};      // resource -> units one harvest gives
const realKinds = [];       // { kind, resource, amount }
for (const kind of Object.keys(NODES)) {
  const n = NODES[kind];
  const res = n.yields || n.yield;                  // terrain.js names it `yields`
  assert(typeof res === 'string' && res, 'terrain node ' + kind + ' has no yields field');
  realAmount[res] = n.amount;                       // amount per harvest of that node
  realKinds.push({ kind, resource: res, amount: n.amount });
}
const REAL_RESOURCES = Object.keys(realAmount);
const MAX_HARVESTS = Eco.MAX_HARVESTS;
assert(REAL_RESOURCES.length > 0, 'terrain.js exposed no node yields');

/** Best-case inventory someone can build from a handful of harvests of each node. */
function yieldFullInv(mult) {
  const inv = Eco.emptyInv();
  for (const r of REAL_RESOURCES) inv[r] = realAmount[r] * MAX_HARVESTS * (mult || 1);
  return inv;
}

// ===========================================================================
// 1. the module itself: dual-target, dependency-free, immutable tables
// ===========================================================================
t('economy.js matches terrain.js node yields exactly (no drift)', () => {
  for (const k of realKinds) {
    const mine = Eco.NODE_YIELDS[k.kind];
    assert(mine, 'economy.js is missing node kind ' + k.kind);
    assert(mine.resource === k.resource, k.kind + ' resource ' + mine.resource + ' != ' + k.resource);
    assert(mine.amount === k.amount, k.kind + ' amount ' + mine.amount + ' != ' + k.amount);
  }
  assert(Object.keys(Eco.NODE_YIELDS).length === realKinds.length, 'node kind count differs');
});

t('dual-target: Node exports the API and a plain <script> gets window.Economy', () => {
  const REQUIRED = ['costOf', 'canAfford', 'applyCost', 'missingFor', 'craft', 'recipesForTier',
    'toolYield', 'toolSpeed', 'ITEMS', 'RECIPES', 'MATERIAL_COSTS', 'TOOL_TIERS'];
  for (const k of REQUIRED) assert(Eco[k] !== undefined, 'missing Node export: ' + k);

  const ctx = {};
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;   // a browser-ish global
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);                                // loaded as a plain <script>
  assert(ctx.Economy && typeof ctx.Economy === 'object', 'window.Economy was not assigned');
  for (const k of REQUIRED) assert(ctx.Economy[k] !== undefined, 'missing browser export: ' + k);
  // Two separate evaluations, so compare behaviour and data, not object identity.
  assert(typeof ctx.Economy.craft === 'function' && typeof ctx.Economy.applyCost === 'function', 'browser build exposes no functions');
  eq(ctx.Economy.MATERIAL_COSTS, Eco.MATERIAL_COSTS, 'browser build has a different material table');
  eq(ctx.Economy.RECIPES, Eco.RECIPES, 'browser build has a different recipe table');
  eq(ctx.Economy.TOOL_TIERS, Eco.TOOL_TIERS, 'browser build has a different tool table');
  const bInv = {}; for (const r of REAL_RESOURCES) bInv[r] = 10;
  eq(canon(ctx.Economy.craft('r_flint_dagger', bInv)), canon(Eco.craft('r_flint_dagger', bInv)), 'browser craft differs from Node craft');
  assert(typeof ctx.module === 'undefined', 'the module leaked a global');
});

t('economy.js is dependency-free and side-effect free (no require/DOM/clock/random)', () => {
  assert(!/(^|[^\w.$])require\s*\(/.test(CODE), 'calls require()');
  assert(!/\bdocument\b/.test(CODE), 'touches document');
  assert(!/\bDate\s*\./.test(CODE), 'touches Date');
  assert(!/\bMath\s*\.\s*random\b/.test(CODE), 'uses Math.random');
  assert(!/\bprocess\s*\./.test(CODE), 'touches process');
  assert(!/\bXMLHttpRequest\b|\bfetch\s*\(/.test(CODE), 'does I/O');
  assert(/\btypeof module\b/.test(CODE), 'does not feature-detect module');
  assert(/root\.Economy\s*=/.test(CODE), 'does not assign window.Economy');
});

t('shared tables are frozen so callers cannot mutate them', () => {
  for (const name of ['ITEMS', 'RECIPES', 'MATERIAL_COSTS', 'TOOL_TIERS', 'NODE_YIELDS', 'STACK_LIMITS', 'MATERIAL_IDS', 'MATERIAL_NAMES']) {
    assert(Object.isFrozen(Eco[name]), name + ' is not frozen');
  }
  assert(Array.isArray(Eco.MATERIAL_COSTS), 'MATERIAL_COSTS is not an array');
  const before = canon(Eco.MATERIAL_COSTS);
  try { Eco.MATERIAL_COSTS[0].wood = 999; } catch (e) { /* strict mode throws: also fine */ }
  try { Eco.MATERIAL_COSTS[0].wood = Eco.MATERIAL_COSTS[0].wood; } catch (e) {}
  eq(canon(Eco.MATERIAL_COSTS), before, 'MATERIAL_COSTS was mutated');
});

t('every export in the returned table carries a one-line comment', () => {
  const start = SRC.lastIndexOf('return {');
  assert(start > 0, 'could not find the return table');
  const block = SRC.slice(start, SRC.indexOf('\n  };', start));
  let checked = 0;
  for (const line of block.split('\n')) {
    const m = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*:/);
    if (!m) continue;
    checked++;
    assert(line.includes('//'), 'export ' + m[1] + ' has no one-line comment');
  }
  assert(checked >= 12, 'only found ' + checked + ' documented exports');
});

// ===========================================================================
// 2. material costs — all 10 materials, payable from real node yields
// ===========================================================================
t('all 10 build materials have a resource cost', () => {
  assert(Eco.MATERIAL_COSTS.length === 10, 'expected 10 material costs, got ' + Eco.MATERIAL_COSTS.length);
  assert(Eco.MATERIAL_IDS.length === 10, 'expected 10 material ids, got ' + Eco.MATERIAL_IDS.length);
  for (let i = 0; i < 10; i++) {
    const c = Eco.costOf(i);
    assert(c && typeof c === 'object', 'material ' + i + ' has no cost');
    assert(keyCount(c) > 0, 'material ' + i + ' costs nothing (gathering stays pointless)');
    assert(Eco.MATERIAL_NAMES[i], 'material ' + i + ' has no name');
  }
  eq(Eco.MATERIAL_IDS, T.PALETTE, 'material ids must match terrain.js PALETTE order');
});

t('costOf/costOfTile return fresh objects and null out of range', () => {
  const a = Eco.costOf(0), b = Eco.costOf(0);
  assert(a !== b, 'costOf returns the shared table entry');
  a.injected = 1;
  assert(Eco.MATERIAL_COSTS[0].injected === undefined, 'costOf leaked a mutable reference');
  assert(Eco.costOf(10) === null && Eco.costOf(-1) === null && Eco.costOf(1.5) === null && Eco.costOf('x') === null, 'costOf out of range must be null');
  eq(Eco.costOfTile(T.PALETTE[9]), Eco.costOf(9), 'costOfTile(10) must equal costOf(9)');
  assert(Eco.costOfTile(999) === null, 'costOfTile of an unknown id must be null');
});

t('no material requires a resource no node can yield, and each is within a few harvests', () => {
  for (let i = 0; i < Eco.MATERIAL_COSTS.length; i++) {
    for (const [res, amt] of Object.entries(Eco.costOf(i))) {
      assert(REAL_RESOURCES.includes(res), 'material ' + i + ' asks for ' + res + ', which no node yields');
      assert(Number.isInteger(amt) && amt > 0, 'material ' + i + ' has a bad amount for ' + res + ': ' + amt);
      assert(amt <= realAmount[res] * MAX_HARVESTS,
        'material ' + i + ' needs ' + amt + ' ' + res + ' — more than ' + MAX_HARVESTS + ' harvests (' +
        realAmount[res] + '/harvest) can supply');
    }
  }
});

t('every material is affordable from an inventory built out of real node yields', () => {
  const inv = yieldFullInv(1);
  for (let i = 0; i < 10; i++) {
    assert(Eco.canAfford(inv, Eco.costOf(i)), 'material ' + i + ' is unaffordable from real yields (' + canon(Eco.costOf(i)) + ')');
    assert(Eco.applyCost(inv, Eco.costOf(i)) !== null, 'applyCost refused material ' + i);
  }
});

t('the sink consumes all four harvested resources (gathering is never pointless)', () => {
  const used = {};
  for (let i = 0; i < 10; i++) for (const r of Object.keys(Eco.costOf(i))) used[r] = 1;
  for (const r of Eco.RECIPES) for (const k of Object.keys(r.inputs)) used[k] = 1;
  for (const r of REAL_RESOURCES) assert(used[r], 'resource ' + r + ' has no sink at all');
});

// ===========================================================================
// 3. recipes — payable, unique, completable to exactly the stated outputs
// ===========================================================================
t('every recipe id is unique and every item id is unique and typed', () => {
  const ids = {};
  for (const r of Eco.RECIPES) {
    assert(!ids[r.id], 'duplicate recipe id: ' + r.id);
    ids[r.id] = 1;
    assert(r.output && Eco.ITEMS[r.output.item], 'recipe ' + r.id + ' outputs unknown item ' + (r.output && r.output.item));
    assert(Number.isInteger(r.output.count) && r.output.count > 0, 'recipe ' + r.id + ' has a bad output count');
    assert(Eco.recipeById(r.id) === r, 'recipeById failed for ' + r.id);
  }
  const itemIds = Object.keys(Eco.ITEMS).map(id => Eco.ITEMS[id].id);
  assert(new Set(itemIds).size === itemIds.length, 'duplicate item id in ITEMS');
  for (const id of itemIds) eq(Eco.itemOf(id).id, id, 'ITEMS key/ id mismatch for ' + id);
});

t('recipes cover weapons (damage bonus) and armour (damage mitigation)', () => {
  const kinds = {};
  for (const r of Eco.RECIPES) {
    const it = Eco.ITEMS[r.output.item];
    kinds[it.kind] = (kinds[it.kind] || 0) + 1;
    if (it.kind === 'weapon') assert(it.damageBonus > 0, it.id + ' is a weapon with no damage bonus');
    else if (it.kind === 'armour') assert(it.mitigation > 0, it.id + ' is armour with no mitigation');
    else throw new Error(it.id + ' has unknown kind ' + it.kind);
  }
  assert(kinds.weapon > 0, 'no weapon recipes');
  assert(kinds.armour > 0, 'no armour recipes');
});

t('no recipe needs a resource no node can yield, and each input is within a few harvests', () => {
  for (const r of Eco.RECIPES) {
    assert(keyCount(r.inputs) > 0, 'recipe ' + r.id + ' has no inputs');
    for (const [res, amt] of Object.entries(r.inputs)) {
      assert(REAL_RESOURCES.includes(res), 'recipe ' + r.id + ' needs ' + res + ', which no node yields');
      assert(Number.isInteger(amt) && amt > 0, 'recipe ' + r.id + ' has a bad amount for ' + res);
      assert(amt <= realAmount[res] * MAX_HARVESTS,
        'recipe ' + r.id + ' needs ' + amt + ' ' + res + ' — beyond ' + MAX_HARVESTS + ' harvests of a yielding node');
    }
    assert(Eco.canAfford(yieldFullInv(1), r.inputs), 'recipe ' + r.id + ' is unaffordable from real yields');
  }
});

t('craft consumes exactly the inputs and returns exactly the outputs', () => {
  for (const r of Eco.RECIPES) {
    const inv = yieldFullInv(1);
    const before = canon(inv);
    const res = Eco.craft(r.id, inv);
    assert(res && res.ok === true, 'craft failed for ' + r.id + ': ' + (res && res.error));
    assert(canon(inv) === before, 'craft mutated the input inventory for ' + r.id);
    assert(res.inv !== inv, 'craft returned the same inventory object for ' + r.id);
    eq(res.outputs, (() => { const o = {}; o[r.output.item] = r.output.count; return o; })(), 'wrong outputs for ' + r.id);
    assert(res.count === r.output.count && res.item === r.output.item, 'wrong item/count for ' + r.id);

    // exact ledger: every key must equal (input - cost) or (input + output)
    const expect = {};
    for (const k of new Set(Object.keys(inv).concat(Object.keys(res.inv)))) {
      const had = inv[k] || 0;
      const spent = r.inputs[k] || 0;
      const got = res.outputs[k] || 0;
      expect[k] = had - spent + got;
    }
    eq(res.inv, expect, 'inventory delta is not exactly inputs-out/outputs-in for ' + r.id);
    for (const k of Object.keys(res.inv)) {
      assert(res.inv[k] >= 0, 'negative balance for ' + k + ' after crafting ' + r.id);
      assert(res.inv[k] <= Eco.stackLimit(k), 'stack limit broken for ' + k + ' after crafting ' + r.id);
    }
    assert(Eco.validate(res.inv).ok, 'crafted inventory does not validate: ' + Eco.validate(res.inv).errors.join('; '));
  }
});

t('craft is deterministic: the same call twice gives identical results', () => {
  for (const r of Eco.RECIPES) {
    const a = Eco.craft(r.id, yieldFullInv(1));
    const b = Eco.craft(r.id, yieldFullInv(1));
    eq(canon(a), canon(b), 'craft(' + r.id + ') is not deterministic');
  }
});

t('recipesForTier returns every recipe up to that tier and nothing above it', () => {
  const max = Eco.maxToolTier();
  let prev = -1;
  for (let tier = 0; tier <= max; tier++) {
    const list = Eco.recipesForTier(tier);
    assert(list.length >= prev, 'recipesForTier shrank at tier ' + tier);
    prev = list.length;
    for (const r of list) assert(r.tier <= tier, 'recipe ' + r.id + ' (tier ' + r.tier + ') leaked into tier ' + tier);
    for (const r of Eco.RECIPES) {
      const shouldBeThere = r.tier <= tier;
      assert(list.includes(r) === shouldBeThere, 'tier ' + tier + ' membership wrong for ' + r.id);
    }
  }
  assert(Eco.recipesForTier(Eco.maxToolTier()).length === Eco.RECIPES.length, 'top tier must unlock every recipe');
  eq(Eco.recipesForTier(-5), [], 'a nonsense tier must unlock nothing');
});

// ===========================================================================
// 4. crafting failure must be clean: no throw, no mutation, no partial charge
// ===========================================================================
t('crafting without enough resources fails cleanly (no throw, no mutation)', () => {
  for (const r of Eco.RECIPES) {
    const short = Eco.emptyInv();                         // literally nothing
    const before = canon(short);
    let res, threw = null;
    try { res = Eco.craft(r.id, short); } catch (e) { threw = e; }
    assert(!threw, 'craft threw for ' + r.id + ': ' + (threw && threw.message));
    assert(res && res.ok === false, 'craft should have failed for ' + r.id);
    assert(typeof res.error === 'string' && res.error.length > 0, 'no error message for ' + r.id);
    assert(res.item === null && res.outputs === null, 'a failed craft must not report outputs');
    assert(canon(short) === before, 'a failed craft mutated the input for ' + r.id);

    // one unit short of the dearest input
    const almost = yieldFullInv(1);
    for (const [k, amt] of Object.entries(r.inputs)) almost[k] = amt - 1;
    const almostBefore = canon(almost);
    const miss = Eco.missingFor(almost, r.inputs);
    assert(Object.keys(miss).length > 0, 'missingFor found no gap for ' + r.id);
    for (const [k, gap] of Object.entries(miss)) assert(gap === 1, 'wrong shortfall for ' + k + ' in ' + r.id);
    assert(Eco.canAfford(almost, r.inputs) === false, 'canAfford said yes while one short for ' + r.id);
    assert(Eco.applyCost(almost, r.inputs) === null, 'applyCost paid a cost it could not afford for ' + r.id);
    const res2 = Eco.craft(r.id, almost);
    assert(res2 && res2.ok === false, 'craft succeeded while one resource short for ' + r.id);
    assert(canon(almost) === almostBefore, 'a failed craft mutated the input for ' + r.id);
  }
});

t('craft fails cleanly on an unknown recipe id and on junk input', () => {
  let threw = null, res;
  try { res = Eco.craft('r_does_not_exist', yieldFullInv(1)); } catch (e) { threw = e; }
  assert(!threw, 'craft threw on an unknown id');
  assert(res && res.ok === false && /unknown recipe/.test(res.error), 'unknown id must fail with a reason');
  const inv = yieldFullInv(1), before = canon(inv);
  assert(Eco.craft(null, inv).ok === false, 'null recipe id must fail');
  assert(Eco.craft(42, inv).ok === false, 'numeric recipe id must fail');
  assert(canon(inv) === before, 'bad recipe ids mutated the inventory');
  assert(Eco.craft('r_flint_dagger', null).ok === false, 'a null inventory must fail, not throw');
});

t('craft refuses to overfill a stack', () => {
  const r = Eco.RECIPES[0];
  const inv = yieldFullInv(1);
  inv[r.output.item] = Eco.stackLimit(r.output.item);     // output slot already at its ceiling
  const before = canon(inv);
  const res = Eco.craft(r.id, inv);
  assert(res.ok === false && /stack/i.test(res.error), 'craft should refuse a full stack');
  assert(canon(inv) === before, 'a refused craft mutated the inventory');
});

// ===========================================================================
// 5. inventory maths — pure, never negative, stack limits enforced
// ===========================================================================
t('applyCost returns a NEW inventory and never mutates its argument', () => {
  const inv = yieldFullInv(1);
  const snapshot = canon(inv);
  const out = Eco.applyCost(inv, Eco.costOf(9));
  assert(canon(inv) === snapshot, 'applyCost mutated its argument');
  assert(out !== inv, 'applyCost returned the same object');
  eq(out.wood, inv.wood - Eco.costOf(9).wood, 'wood not deducted correctly');
  assert(out.crystal === inv.crystal - 1, 'crystal not deducted correctly');
  const untouched = yieldFullInv(1);
  const out2 = Eco.applyCost(untouched, {});
  assert(canon(untouched) === canon(yieldFullInv(1)), 'a no-op cost mutated the inventory');
  assert(out2 !== untouched, 'a no-op cost must still return a fresh object');
});

t('canAfford and applyCost never produce a negative balance (deterministic sweep)', () => {
  let seed = 1337;
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 4000; i++) {
    const inv = {};
    for (const r of REAL_RESOURCES) inv[r] = next(6);
    const cost = {};
    for (const r of REAL_RESOURCES) if (next(3) === 0) cost[r] = 1 + next(6);
    const before = canon(inv);
    const can = Eco.canAfford(inv, cost);
    const out = Eco.applyCost(inv, cost);
    if (can) {
      assert(out !== null, 'affordable cost returned null: ' + canon(inv) + ' vs ' + canon(cost));
      for (const r of REAL_RESOURCES) {
        assert(out[r] >= 0, 'negative balance for ' + r);
        eq(out[r], inv[r] - (cost[r] || 0), 'wrong deduction for ' + r + ' from ' + canon(inv) + ' paying ' + canon(cost));
      }
      eq(Eco.missingFor(inv, cost), {}, 'missingFor should be empty when affordable');
    } else {
      assert(out === null, 'unaffordable cost was paid: ' + canon(inv) + ' vs ' + canon(cost));
      const miss = Eco.missingFor(inv, cost);
      assert(Object.keys(miss).length > 0, 'unaffordable cost reported no shortfall');
      for (const [k, gap] of Object.entries(miss)) eq(gap, cost[k] - (inv[k] || 0), 'wrong shortfall for ' + k);
    }
    assert(canon(inv) === before, 'the inventory was mutated during the sweep');
  }
  assert(Eco.canAfford(null, { wood: 1 }) === false, 'canAfford(null) must be false');
  assert(Eco.canAfford({ wood: 5 }, null) === false, 'canAfford with no cost must be false');
  assert(Eco.applyCost({ wood: 1 }, { wood: 2 }) === null, 'applyCost must return null when short');
});

t('stack limits are enforced: add clamps, validate flags overflow, limits are positive', () => {
  for (const r of REAL_RESOURCES) {
    assert(Number.isInteger(Eco.stackLimit(r)) && Eco.stackLimit(r) > 0, 'no positive stack limit for ' + r);
  }
  for (const r of REAL_RESOURCES) {
    const limit = Eco.stackLimit(r);
    const inv = Eco.emptyInv();
    const out = Eco.add(inv, r, limit + 25);
    assert(out[r] === limit, r + ' exceeded its stack limit: ' + out[r] + ' > ' + limit);
    assert(inv[r] === 0, 'add mutated its argument');
    assert(Eco.roomFor(out, r) === 0, 'roomFor should be 0 at the ceiling');
    assert(Eco.validate(out).ok, 'a clamped stack must validate');
    assert(Eco.validate({ [r]: limit + 1 }).ok === false, 'validate let an overflow through for ' + r);
    assert(Eco.validate({ [r]: -3 }).ok === false, 'validate let a negative balance through for ' + r);
    assert(Eco.validate({ [r]: 1.5 }).ok === false, 'validate let a fractional balance through for ' + r);
    assert(Eco.validate('nonsense').ok === false, 'validate let a non-object through');
    assert(Eco.remove(out, r, 5) !== null && Eco.remove(Eco.emptyInv(), r, 5)[r] === 0, 'remove went negative');
    assert(Eco.remove(Eco.emptyInv(), r, 5)[r] >= 0, 'remove produced a negative balance');
    assert(Eco.add(inv, r, -1) === null, 'add accepted a negative amount');
  }
  for (const id of Object.keys(Eco.ITEMS)) {
    assert(Number.isInteger(Eco.stackLimit(id)) && Eco.stackLimit(id) > 0, 'no stack limit for item ' + id);
  }
  assert(Eco.stackLimit('never_heard_of_it') > 0, 'unknown keys need a default stack limit');
});

// ===========================================================================
// 6. tool tiers — strictly increasing, gated by real resource cost
// ===========================================================================
t('tool tiers strictly increase in both yield and speed', () => {
  assert(Eco.TOOL_TIERS.length >= 4, 'expected at least flint/copper/iron/steel');
  const order = ['flint', 'copper', 'iron', 'steel'];
  order.forEach((name, i) => assert(Eco.TOOL_TIERS[i].id === name, 'tier ' + i + ' should be ' + name + ', got ' + Eco.TOOL_TIERS[i].id));
  Eco.TOOL_TIERS.forEach((tt, i) => assert(tt.tier === i, 'tier index mismatch at ' + i));

  for (let i = 1; i < Eco.TOOL_TIERS.length; i++) {
    const lo = Eco.TOOL_TIERS[i - 1], hi = Eco.TOOL_TIERS[i];
    assert(Eco.toolSpeed(i) > Eco.toolSpeed(i - 1), 'speed must rise from ' + lo.id + ' to ' + hi.id);
    for (const k of Object.keys(Eco.NODE_YIELDS)) {
      const a = Eco.toolYield(i - 1, k), b = Eco.toolYield(i, k);
      assert(typeof a === 'number' && typeof b === 'number', 'toolYield returned non-numbers for ' + k);
      assert(b > a, 'yield must rise for node ' + k + ': ' + a + ' -> ' + b);
      assert(a > 0, 'yield multiplier must stay positive for ' + k);
      assert(Eco.toolHarvestAmount(i, k) >= Eco.toolHarvestAmount(i - 1, k), 'harvest amount dropped for ' + k);
    }
  }
  // the same strict rise must hold when kinds are named as terrain names or ids
  for (const k of Object.keys(Eco.NODE_YIELDS)) {
    eq(Eco.toolYield(3, k), Eco.toolYield(3, k.toLowerCase()), 'kind lookup is case-sensitive for ' + k);
    eq(Eco.toolYield(3, Eco.NODE_YIELDS[k].id), Eco.toolYield(3, k), 'kind lookup by id failed for ' + k);
  }
  assert(Eco.toolYield(0, 'ORE') < Eco.toolYield(3, 'ORE'), 'steel must out-yield flint on ore');
  assert(Eco.toolYield(99, 'ORE') === null && Eco.toolSpeed(99) === null, 'a nonsense tier must yield null');
});

t('tool tiers are gated by resource costs that real nodes can actually pay', () => {
  for (let i = 0; i < Eco.TOOL_TIERS.length; i++) {
    const cost = Eco.toolCost(i);
    assert(cost && keyCount(cost) > 0, 'tier ' + i + ' is not gated by any resource cost');
    for (const [res, amt] of Object.entries(cost)) {
      assert(REAL_RESOURCES.includes(res), 'tier ' + i + ' asks for ' + res + ', which no node yields');
      assert(amt <= realAmount[res] * MAX_HARVESTS, 'tier ' + i + ' needs ' + amt + ' ' + res + ' — too many harvests');
    }
    const inv = yieldFullInv(1);
    assert(Eco.canAfford(inv, cost), 'tier ' + i + ' is unaffordable from real yields');
    assert(Eco.applyCost(inv, cost) !== null, 'could not pay for tier ' + i);
  }
  assert(Eco.toolCost(99) === null, 'toolCost of a nonsense tier must be null');
  assert(Eco.TOOL_TIERS[Eco.maxToolTier()].cost && keyCount(Eco.TOOL_TIERS[Eco.maxToolTier()].cost) > 0, 'steel must be gated');
  // the tiers must not all cost the same thing
  const shapes = new Set(Eco.TOOL_TIERS.map(tt => canon(tt.cost)));
  assert(shapes.size === Eco.TOOL_TIERS.length, 'tool tier costs must be distinct');
});

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
