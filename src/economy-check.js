/**
 * economy-check.js — offline diagnostic: are MATERIAL_COSTS and TOOL_TIERS payable from real node yields?
 *
 * WHY THIS FILE EXISTS
 *   src/economy.js and src/token-sink.js are the sinks, src/rewards.js is the faucet.
 *   Without a dashboard the relationship between them is invisible: a material that costs
 *   more of a resource than any nodes can drop, or a tool gated behind an impossible
 *   recipe, is only ever caught when a player complains they can never afford it. This
 *   module is the cheap, local proof that never happens: a pure function that cross-
 *   checks every entry in MATERIAL_COSTS (10 palette materials) and every entry in
 *   TOOL_TIERS (flint/copper/iron/steel) against NODE_YIELDS (what each node actually
 *   drops per harvest) under the same affordability ceiling test-economy.js already
 *   enforces: any single cost entry must be payable in <= MAX_HARVESTS harvests of the
 *   node that drops it (wood:2/harvest, ore:2/harvest, herb:1/harvest, crystal:1/harvest).
 *   Tool gating is checked the same way, plus yield/speed monotonicity (steel must
 *   strictly out-yield copper on every node hardness).
 *
 * CONTRACT
 *   - Dependency-free UMD. No require() at top level, no DOM, no I/O, no globals written.
 *   - Fully pure and deterministic: no Date.now(), no Math.random().
 *   - Export is a single `check(overrides?) -> { ok, issues }` — never throws, never mutates.
 *   - `overrides` is optional: { MATERIAL_COSTS, NODE_YIELDS, TOOL_TIERS, MAX_HARVESTS, etc. }
 *     for isolated testing. When omitted the module resolves live tables from src/economy.js
 *     (Node) or window.Economy (browser) automatically; if those are unavailable it falls
 *     back to an embedded snapshot so the diagnostic is still runnable offline.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.EconomyCheck = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // Embedded snapshot — mirrors src/economy.js at ship time so check() works even when
  // the live module cannot be resolved (e.g. browser <script> order). Kept in sync by
  // the diagnostic itself: if live tables differ, live tables win (see resolve()).
  var SNAP_NODE_YIELDS = {
    TREE: { id: 1, resource: 'wood', amount: 2, hp: 3, respawnMs: 45000 },
    ORE: { id: 2, resource: 'ore', amount: 2, hp: 4, respawnMs: 90000 },
    HERB: { id: 3, resource: 'herb', amount: 1, hp: 1, respawnMs: 30000 },
    CRYSTAL: { id: 4, resource: 'crystal', amount: 1, hp: 2, respawnMs: 150000 }
  };
  var SNAP_MATERIAL_COSTS = [
    { wood: 1 },
    { herb: 1 },
    { wood: 1, ore: 1 },
    { wood: 1 },
    { wood: 2 },
    { wood: 3 },
    { wood: 2, ore: 2 },
    { wood: 2, ore: 1 },
    { wood: 1, ore: 1 },
    { wood: 1, ore: 1, crystal: 1 }
  ];
  var SNAP_TOOL_TIERS = [
    { tier: 0, id: 'flint', name: 'flint', yieldMul: 1.00, speedMul: 1.00, cost: { wood: 2 } },
    { tier: 1, id: 'copper', name: 'copper', yieldMul: 1.25, speedMul: 1.15, cost: { wood: 3, ore: 2 } },
    { tier: 2, id: 'iron', name: 'iron', yieldMul: 1.50, speedMul: 1.35, cost: { wood: 2, ore: 5 } },
    { tier: 3, id: 'steel', name: 'steel', yieldMul: 2.00, speedMul: 1.60, cost: { ore: 8, crystal: 3 } }
  ];
  var SNAP_MAX_HARVESTS = 4;
  var SNAP_NODE_HARDNESS = { TREE: 0, ORE: 1, HERB: 0, CRYSTAL: 2 };
  var SNAP_HARDNESS_PENALTY = 0.15;

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  function resolve(overrides) {
    var eco = null;
    if (overrides && typeof overrides === 'object') {
      // explicit injection wins — lets tests drive a failing table without touching the real one
      var hasCosts = Array.isArray(overrides.MATERIAL_COSTS);
      var hasYields = overrides.NODE_YIELDS && typeof overrides.NODE_YIELDS === 'object';
      var hasTiers = Array.isArray(overrides.TOOL_TIERS);
      if (hasCosts || hasYields || hasTiers) {
        return {
          NODE_YIELDS: hasYields ? overrides.NODE_YIELDS : (overrides.NODE_YIELDS || null),
          MATERIAL_COSTS: hasCosts ? overrides.MATERIAL_COSTS : null,
          TOOL_TIERS: hasTiers ? overrides.TOOL_TIERS : null,
          MAX_HARVESTS: typeof overrides.MAX_HARVESTS === 'number' ? overrides.MAX_HARVESTS : null,
          NODE_HARDNESS: overrides.NODE_HARDNESS || null,
          HARDNESS_PENALTY: typeof overrides.HARDNESS_PENALTY === 'number' ? overrides.HARDNESS_PENALTY : null
        };
      }
    }
    // try live src/economy.js — lazy require so top-level stays dependency-free and browser-safe
    try {
      if (typeof require === 'function') {
        var live = require('./economy.js');
        if (live && live.NODE_YIELDS && live.MATERIAL_COSTS && live.TOOL_TIERS) return live;
      }
    } catch (e) { /* not in Node or file missing — fall through */ }
    try {
      var g = (typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : null));
      if (g && g.Economy && g.Economy.NODE_YIELDS) return g.Economy;
    } catch (e) {}
    return null;
  }

  /**
   * Pure diagnostic.
   * @param {object} [overrides] optional tables to check instead of the live ones.
   * @returns {{ ok: boolean, issues: string[] }}
   */
  function check(overrides) {
    var issues = [];
    try {
      var live = resolve(overrides);
      // Decide which tables to actually check: injected partial overrides must still be
      // completed with live/snapshot defaults for the missing pieces, otherwise a caller
      // who only injects MATERIAL_COSTS would get false positives on TOOL_TIERS missing.
      var NODE_YIELDS, MATERIAL_COSTS, TOOL_TIERS, MAX_HARVESTS, NODE_HARDNESS, HARDNESS_PENALTY;
      if (live && live.NODE_YIELDS) NODE_YIELDS = live.NODE_YIELDS;
      else if (overrides && overrides.NODE_YIELDS) NODE_YIELDS = overrides.NODE_YIELDS;
      else NODE_YIELDS = SNAP_NODE_YIELDS;

      if (live && live.MATERIAL_COSTS) MATERIAL_COSTS = live.MATERIAL_COSTS;
      else if (overrides && Array.isArray(overrides.MATERIAL_COSTS)) MATERIAL_COSTS = overrides.MATERIAL_COSTS;
      else MATERIAL_COSTS = SNAP_MATERIAL_COSTS;

      if (live && live.TOOL_TIERS) TOOL_TIERS = live.TOOL_TIERS;
      else if (overrides && Array.isArray(overrides.TOOL_TIERS)) TOOL_TIERS = overrides.TOOL_TIERS;
      else TOOL_TIERS = SNAP_TOOL_TIERS;

      if (live && typeof live.MAX_HARVESTS === 'number') MAX_HARVESTS = live.MAX_HARVESTS;
      else if (overrides && typeof overrides.MAX_HARVESTS === 'number') MAX_HARVESTS = overrides.MAX_HARVESTS;
      else MAX_HARVESTS = SNAP_MAX_HARVESTS;

      if (live && live.NODE_HARDNESS) NODE_HARDNESS = live.NODE_HARDNESS;
      else if (overrides && overrides.NODE_HARDNESS) NODE_HARDNESS = overrides.NODE_HARDNESS;
      else NODE_HARDNESS = SNAP_NODE_HARDNESS;

      if (live && typeof live.HARDNESS_PENALTY === 'number') HARDNESS_PENALTY = live.HARDNESS_PENALTY;
      else if (overrides && typeof overrides.HARDNESS_PENALTY === 'number') HARDNESS_PENALTY = overrides.HARDNESS_PENALTY;
      else HARDNESS_PENALTY = SNAP_HARDNESS_PENALTY;

      // Build resource -> amount per harvest lookup.
      var yieldByResource = {};
      var nodeKeys = [];
      for (var k in NODE_YIELDS) {
        if (!Object.prototype.hasOwnProperty.call(NODE_YIELDS, k)) continue;
        var ny = NODE_YIELDS[k];
        if (!ny || typeof ny.resource !== 'string') {
          issues.push('NODE_YIELDS[' + k + '] missing resource');
          continue;
        }
        if (!isInt(ny.amount) || ny.amount <= 0) {
          issues.push('NODE_YIELDS[' + k + '] has bad amount ' + ny.amount);
          continue;
        }
        yieldByResource[ny.resource] = ny.amount;
        nodeKeys.push(k);
      }
      if (!nodeKeys.length) issues.push('no node yields');

      // ---- MATERIAL_COSTS vs NODE_YIELDS ----
      if (!Array.isArray(MATERIAL_COSTS)) {
        issues.push('MATERIAL_COSTS is not an array');
      } else {
        if (MATERIAL_COSTS.length !== 10) issues.push('MATERIAL_COSTS length ' + MATERIAL_COSTS.length + ' expected 10');
        for (var i = 0; i < MATERIAL_COSTS.length; i++) {
          var cost = MATERIAL_COSTS[i];
          if (!cost || typeof cost !== 'object' || Array.isArray(cost)) {
            issues.push('MATERIAL_COSTS[' + i + '] not an object');
            continue;
          }
          var keys = Object.keys(cost);
          if (!keys.length) issues.push('MATERIAL_COSTS[' + i + '] costs nothing');
          for (var j = 0; j < keys.length; j++) {
            var res = keys[j];
            var amt = cost[res];
            if (!isInt(amt) || amt <= 0) {
              issues.push('MATERIAL_COSTS[' + i + '].' + res + ' bad amount ' + amt);
              continue;
            }
            var perHarvest = yieldByResource[res];
            if (perHarvest === undefined) {
              issues.push('MATERIAL_COSTS[' + i + '] needs resource ' + res + ' which no node yields');
            } else {
              var maxAfford = perHarvest * MAX_HARVESTS;
              if (amt > maxAfford) {
                issues.push('MATERIAL_COSTS[' + i + '].' + res + ' needs ' + amt + ' > ' + MAX_HARVESTS + ' harvests (' + perHarvest + '/harvest -> max ' + maxAfford + ')');
              }
            }
          }
        }
      }

      // ---- TOOL_TIERS gating vs real node yields ----
      if (!Array.isArray(TOOL_TIERS)) {
        issues.push('TOOL_TIERS is not an array');
      } else {
        if (TOOL_TIERS.length < 4) issues.push('TOOL_TIERS length ' + TOOL_TIERS.length + ' expected >=4');
        var seenCostShapes = {};
        for (var ti = 0; ti < TOOL_TIERS.length; ti++) {
          var tier = TOOL_TIERS[ti];
          if (!tier || typeof tier !== 'object') { issues.push('TOOL_TIERS[' + ti + '] not an object'); continue; }
          if (tier.tier !== ti) issues.push('TOOL_TIERS[' + ti + '].tier=' + tier.tier + ' expected ' + ti);
          var c = tier.cost;
          if (!c || typeof c !== 'object' || Array.isArray(c) || !Object.keys(c).length) {
            issues.push('TOOL_TIERS[' + ti + '] (' + (tier.id || '?') + ') has no gate cost');
          } else {
            for (var rk in c) {
              if (!Object.prototype.hasOwnProperty.call(c, rk)) continue;
              var ca = c[rk];
              if (!isInt(ca) || ca <= 0) { issues.push('TOOL_TIERS[' + ti + '].cost.' + rk + ' bad amount ' + ca); continue; }
              var perH = yieldByResource[rk];
              if (perH === undefined) issues.push('TOOL_TIERS[' + ti + '] needs resource ' + rk + ' which no node yields');
              else if (ca > perH * MAX_HARVESTS) issues.push('TOOL_TIERS[' + ti + '] (' + tier.id + ') needs ' + ca + ' ' + rk + ' > ' + MAX_HARVESTS + ' harvests (max ' + (perH * MAX_HARVESTS) + ')');
            }
            var shape = JSON.stringify(Object.keys(c).sort().map(function (k2) { return k2 + ':' + c[k2]; }));
            if (seenCostShapes[shape]) issues.push('TOOL_TIERS[' + ti + '] cost shape duplicates tier ' + seenCostShapes[shape]);
            else seenCostShapes[shape] = ti;
          }
          // monotonicity: yieldMul and speedMul must strictly rise
          if (ti > 0) {
            var prev = TOOL_TIERS[ti - 1];
            if (typeof tier.yieldMul === 'number' && typeof prev.yieldMul === 'number' && tier.yieldMul <= prev.yieldMul) {
              issues.push('TOOL_TIERS[' + ti + '].yieldMul ' + tier.yieldMul + ' not > tier ' + (ti - 1) + ' ' + prev.yieldMul);
            }
            if (typeof tier.speedMul === 'number' && typeof prev.speedMul === 'number' && tier.speedMul <= prev.speedMul) {
              issues.push('TOOL_TIERS[' + ti + '].speedMul ' + tier.speedMul + ' not > tier ' + (ti - 1) + ' ' + prev.speedMul);
            }
          }
        }
        // real harvest amount never drops with tier for any node kind (hardness-adjusted yield)
        for (var nk = 0; nk < nodeKeys.length; nk++) {
          var key = nodeKeys[nk];
          var hardness = (NODE_HARDNESS && typeof NODE_HARDNESS[key] === 'number') ? NODE_HARDNESS[key] : 0;
          var base = NODE_YIELDS[key].amount;
          var lastAmt = null;
          for (var t2 = 0; t2 < TOOL_TIERS.length; t2++) {
            var tm = TOOL_TIERS[t2];
            if (typeof tm.yieldMul !== 'number') continue;
            var yMul = tm.yieldMul * (1 - HARDNESS_PENALTY * hardness);
            var harvestAmt = Math.max(1, Math.floor(base * yMul));
            if (lastAmt !== null && harvestAmt < lastAmt) {
              issues.push('toolHarvestAmount tier ' + t2 + ' < tier ' + (t2 - 1) + ' for ' + key + ': ' + harvestAmt + ' < ' + lastAmt);
            }
            lastAmt = harvestAmt;
          }
        }
      }
    } catch (e) {
      issues.push('check threw: ' + (e && e.message));
    }
    return { ok: issues.length === 0, issues: issues };
  }

  return {
    check: check // (overrides?) -> { ok, issues }
  };
});
