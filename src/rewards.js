/**
 * rewards.js — dual commerce rewards for STRATUM (in-game gold + token units).
 *
 * Mining, crafting, and combat grant soft gold (inventory) and hard token units
 * (server ledger → future on-chain claim). Rates live here so economy.js stays
 * about materials and this file stays about commerce payouts.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O.
 *   - Pure + deterministic: no Date.now(), no Math.random().
 *   - Never mutates arguments; always returns a fresh { gold, token }.
 *   - Malformed action/ctx → { gold: 0, token: 0 }, never throws.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Rewards = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  function zero() { return { gold: 0, token: 0 }; }

  /** Base tables — whole units (token is pre-decimals ledger units). */
  var RATES = deepFreeze({
    harvest: { gold: 1, token: 1 },
    craft: { goldBase: 2, goldPerTier: 1, token: 2 },
    kill: { gold: 2, token: 2 },
    collect: { gold: 1, token: 0 }
  });

  var ACTIONS = deepFreeze(['harvest', 'craft', 'kill', 'collect']);

  /**
   * Dual reward for a successful gameplay action.
   * @param {string} action  'harvest' | 'craft' | 'kill' | 'collect'
   * @param {object} [ctx]   optional { tier, xp, kind }
   * @returns {{ gold: number, token: number }}
   */
  function rewardFor(action, ctx) {
    if (typeof action !== 'string' || ACTIONS.indexOf(action) === -1) return zero();
    try {
      if (action === 'harvest') {
        return { gold: RATES.harvest.gold, token: RATES.harvest.token };
      }
      if (action === 'craft') {
        var tier = 0;
        if (ctx && typeof ctx.tier === 'number' && isFinite(ctx.tier) && ctx.tier >= 0) {
          tier = Math.floor(ctx.tier);
        }
        return {
          gold: RATES.craft.goldBase + RATES.craft.goldPerTier * tier,
          token: RATES.craft.token
        };
      }
      if (action === 'kill') {
        var xp = 0;
        if (ctx && typeof ctx.xp === 'number' && isFinite(ctx.xp) && ctx.xp > 0) xp = Math.floor(ctx.xp);
        var bonus = Math.floor(xp / 10);
        return { gold: RATES.kill.gold, token: RATES.kill.token + bonus };
      }
      if (action === 'collect') {
        return { gold: RATES.collect.gold, token: RATES.collect.token };
      }
    } catch (e) { /* never throw */ }
    return zero();
  }

  /** True when either leg of a reward is positive. */
  function hasReward(r) {
    return !!(r && ((r.gold | 0) > 0 || (r.token | 0) > 0));
  }

  return {
    ACTIONS: ACTIONS,
    RATES: RATES,
    rewardFor: rewardFor,
    hasReward: hasReward
  };
});
