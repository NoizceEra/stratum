/**
 * holder-bonus.js — "simple as holding the token": a wallet's on-chain STRATUM balance
 * grants a permanent multiplier on the gold/STRATUM a player earns from playing.
 *
 * WHY THIS FILE EXISTS
 *   Every other commerce module here answers "what happens when you spend/earn STRATUM
 *   during a session" (src/rewards.js mints it, src/token-sink.js drains it). This
 *   module answers a different question the project owner asked for: "why would anyone
 *   HOLD STRATUM instead of immediately spending it?" The answer is a yield-style tier
 *   table — the more STRATUM your linked wallet holds, the bigger a multiplier is applied
 *   to every gold/token reward src/rewards.js hands you. It is deliberately the
 *   simplest possible hook: no staking, no lockup, no claim step — just holding more
 *   moves you up a tier, permanently, for as long as the balance is above threshold.
 *
 * WHY THIS MODULE NEVER TOUCHES A CHAIN BALANCE ITSELF
 *   STRATUM has no live on-chain mint yet — src/token-config.js carries the
 *   `STRM_MINT_NOT_YET_DEPLOYED` sentinel, and src/chain-adapter.js
 *   gates all real settlement behind that flag (see its header + README.md's Commerce
 *   section for the full story). Any balance this module were handed today could be
 *   meaningless, or worse, wrong. So this module simply never decides what "the
 *   balance" is — it is 100% pure math over whatever number the caller hands it. It is
 *   the caller's (server.js, wired later, NOT this module) job to decide whether to
 *   pass a real on-chain balance or always pass 0 until the real contract exists. That
 *   keeps this module correct and testable today, and requires zero changes on the day
 *   the real contract goes live — only server.js's wiring changes, not this file.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.HolderBonus = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh values (or a shared frozen tier reference) and never
 *     mutates its arguments.
 *   - Integer math for reward amounts — gold/STRATUM are always whole ledger units
 *     elsewhere in this codebase (src/rewards.js). The multiplier itself is a float
 *     (e.g. 1.25); applying it to an amount floors to an integer, matching
 *     token-sink.js's splitBurn "floor, never round up" convention — except here the
 *     floor can never push a reward BELOW its original un-boosted amount, since the
 *     whole point of this module is to only ever reward holding, never punish it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.HolderBonus = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function isInt(n) { return isNum(n) && Math.floor(n) === n; }
  function isNonNegInt(n) { return isInt(n) && n >= 0; }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  /** No-bonus baseline — every wallet starts here, including one with a malformed or
   *  unreadable balance. Named for flavor consistency with the tiers above it. */
  var BASE_MULTIPLIER = 1.0;

  // ======================================================================
  // the tier table — ascending by minBalance, decided by the project owner
  // ======================================================================

  /** Frozen, ascending by minBalance. `tierFor` returns these exact object references
   *  (never a clone) so callers can compare tiers by identity if they want to. */
  var TIERS = deepFreeze([
    { minBalance: 0, multiplier: 1.00, name: 'Colonist' },
    { minBalance: 100, multiplier: 1.10, name: 'Backer' },
    { minBalance: 1000, multiplier: 1.25, name: 'Investor' },
    { minBalance: 10000, multiplier: 1.50, name: 'Founder' },
    { minBalance: 100000, multiplier: 2.00, name: 'Silverlord' }
  ]);

  /**
   * The tier for a given on-chain STRATUM balance. Walks TIERS from the top down and
   * returns the highest tier whose minBalance the balance clears. Malformed input
   * (non-number, NaN, Infinity, negative) always resolves to the base Colonist tier —
   * never throws, never returns undefined. Returns the actual frozen tier object from
   * TIERS, not a copy.
   */
  function tierFor(balance) {
    if (!isNum(balance) || balance < 0) return TIERS[0];
    var best = TIERS[0];
    for (var i = 0; i < TIERS.length; i++) {
      if (balance >= TIERS[i].minBalance) best = TIERS[i];
    }
    return best;
  }

  /** Convenience wrapper: just the multiplier number for a given balance. */
  function multiplierFor(balance) {
    return tierFor(balance).multiplier;
  }

  /**
   * Apply a multiplier to a whole-unit reward amount, flooring the product. Guarantees:
   *   - never returns less than `amount` (a malformed/sub-1.0 multiplier is clamped up
   *     to 1.0 rather than ever shrinking a reward — this module only ever rewards
   *     holding, never punishes it).
   *   - malformed `amount` (non-integer, negative, non-number) -> 0, never throws.
   *   - malformed `multiplier` (non-number, NaN, Infinity) -> treated as 1.0 (no bonus).
   */
  function boostedAmount(amount, multiplier) {
    if (!isNonNegInt(amount)) return 0;
    var m = isNum(multiplier) ? multiplier : BASE_MULTIPLIER;
    if (m < BASE_MULTIPLIER) m = BASE_MULTIPLIER;
    return Math.floor(amount * m);
  }

  /**
   * Apply `boostedAmount` to both legs of a { gold, token } reward (src/rewards.js's
   * shape). Missing/malformed gold or token fields are treated as 0. Always returns a
   * fresh { gold, token } object — never mutates the input.
   */
  function boostedReward(reward, multiplier) {
    var gold = reward && isNonNegInt(reward.gold) ? reward.gold : 0;
    var token = reward && isNonNegInt(reward.token) ? reward.token : 0;
    return {
      gold: boostedAmount(gold, multiplier),
      token: boostedAmount(token, multiplier)
    };
  }

  return {
    BASE_MULTIPLIER: BASE_MULTIPLIER,
    TIERS: TIERS,                   // frozen, ascending by minBalance.
    tierFor: tierFor,               // { minBalance, multiplier, name } for a balance.
    multiplierFor: multiplierFor,   // just the multiplier number for a balance.
    boostedAmount: boostedAmount,   // floor(amount * clamped-multiplier), never < amount.
    boostedReward: boostedReward    // { gold, token } with boostedAmount applied to both.
  };
});
