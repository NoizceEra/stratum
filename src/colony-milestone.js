/**
 * colony-milestone.js — a community-wide yield bonus fed by the server's burn total.
 *
 * WHY THIS FILE EXISTS
 *   src/token-sink.js gives every spend a permanent, never-decreasing footprint: most of
 *   what a player burns through Earth Requisition or Structure Rush is destroyed forever,
 *   and the running total of everything ever destroyed (server.js's burnedTotal(), stored
 *   in the token_burned table, surfaced today as colonyQuota in /api/stats and the HUD's
 *   "silver shipped" counter) only ever goes up. That total is a fact about the WHOLE
 *   COMMUNITY, not any one player — no single player can move it far on their own, but
 *   everyone spending together can. This module turns that shared, ratcheting total into
 *   a shared, ratcheting reward: as colonyQuota crosses each threshold, EVERY player's
 *   mining/gameplay yield gets a small permanent multiplier bump, applied identically
 *   regardless of who did the spending.
 *
 *   The intent is a flywheel, not a bank account: spending STRM (which destroys most of
 *   it) makes everyone's future earning better, which gives players a reason to spend
 *   even though burning feels like a loss in the moment. This is deliberately the
 *   opposite shape from a personal "hold this much STRM" bonus (a different module,
 *   built in parallel, rewards NOT spending) — here the reward is for the community
 *   having spent, and it can never go down once earned, because colonyQuota itself never
 *   decreases. There is no un-burning STRM, so there is no un-earning a colony milestone.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.ColonyMilestone = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     This module NEVER reads the real colonyQuota itself — server.js computes that
 *     running total and passes it in as a plain number on every call. Every helper
 *     returns fresh values and never mutates its arguments.
 *   - Integer math for reward amounts; the multiplier is a float, floored on application,
 *     same "floor, never round up, never reduce below the original" convention as
 *     token-sink.js's splitBurn.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.ColonyMilestone = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  // ======================================================================
  // the milestone table
  // ======================================================================

  /** No bonus yet — the starting tier every server begins at before any community
   *  spending has accumulated. */
  var BASE_MULTIPLIER = 1.0;

  /**
   * Thresholds on the server-wide, never-decreasing colonyQuota (total STRM ever burned
   * via a sink, across ALL players). Ascending by minQuota; the last tier has no upper
   * bound. Values are fixed by the project owner — do not redesign them.
   */
  var TIERS = deepFreeze([
    { minQuota: 0, multiplier: 1.00, name: 'Outpost' },
    { minQuota: 1000, multiplier: 1.02, name: 'Settlement' },
    { minQuota: 10000, multiplier: 1.05, name: 'Colony' },
    { minQuota: 100000, multiplier: 1.10, name: 'Province' },
    { minQuota: 1000000, multiplier: 1.20, name: 'Dominion' }
  ]);

  /**
   * Returns the tier (the actual frozen object, not a clone) matching `colonyQuota`.
   * Malformed/negative/non-finite/non-number input always resolves to the base
   * "Outpost" tier — never throws, never returns undefined.
   */
  function milestoneFor(colonyQuota) {
    if (!isNum(colonyQuota) || colonyQuota < 0) return TIERS[0];
    var match = TIERS[0];
    for (var i = 0; i < TIERS.length; i++) {
      if (colonyQuota >= TIERS[i].minQuota) match = TIERS[i];
      else break;
    }
    return match;
  }

  /** Convenience wrapper: just the multiplier for a given colonyQuota. */
  function multiplierFor(colonyQuota) {
    return milestoneFor(colonyQuota).multiplier;
  }

  /**
   * Returns { name, minQuota, remaining } for the next tier up (the smallest minQuota
   * strictly greater than colonyQuota), or null if colonyQuota is already at or past the
   * final tier's threshold — there is no next milestone, the flywheel is maxed.
   * Malformed/negative/non-finite/non-number input is treated as 0 (next is the first
   * tier above the base).
   */
  function nextMilestone(colonyQuota) {
    var q = (isNum(colonyQuota) && colonyQuota >= 0) ? colonyQuota : 0;
    for (var i = 0; i < TIERS.length; i++) {
      if (TIERS[i].minQuota > q) {
        return { name: TIERS[i].name, minQuota: TIERS[i].minQuota, remaining: TIERS[i].minQuota - q };
      }
    }
    return null;
  }

  // ======================================================================
  // applying the multiplier
  // ======================================================================

  /**
   * Applies `multiplier` to `amount`, floored, never below the original `amount`.
   * Malformed multiplier -> treated as 1.0 (no-op). Malformed amount -> treated as 0.
   * Never throws on garbage input of any kind.
   */
  function boostedAmount(amount, multiplier) {
    var a = (isNum(amount) && amount > 0) ? amount : 0;
    if (a === 0) return 0;
    var m = (isNum(multiplier) && multiplier > 0) ? multiplier : 1.0;
    var boosted = Math.floor(a * m);
    return boosted > a ? boosted : a;
  }

  /**
   * Same semantics as boostedAmount, applied to a { gold, token } reward shape. Missing
   * or malformed fields are treated as 0. Never throws on garbage input.
   */
  function boostedReward(reward, multiplier) {
    var gold = (reward && isNum(reward.gold) && reward.gold > 0) ? reward.gold : 0;
    var token = (reward && isNum(reward.token) && reward.token > 0) ? reward.token : 0;
    return {
      gold: boostedAmount(gold, multiplier),
      token: boostedAmount(token, multiplier)
    };
  }

  return {
    BASE_MULTIPLIER: BASE_MULTIPLIER,
    TIERS: TIERS,                       // frozen, ascending by minQuota.
    milestoneFor: milestoneFor,         // matching tier object for a colonyQuota.
    multiplierFor: multiplierFor,       // just the multiplier for a colonyQuota.
    nextMilestone: nextMilestone,       // { name, minQuota, remaining } or null.
    boostedAmount: boostedAmount,       // floored, never below original amount.
    boostedReward: boostedReward        // { gold, token } boosted the same way.
  };
});
