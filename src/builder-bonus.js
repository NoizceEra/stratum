/**
 * builder-bonus.js — "simple as building": how many structures you currently have
 * standing on your own claimed land grants a permanent multiplier on the gold/STRM
 * you earn from playing.
 *
 * WHY THIS FILE EXISTS
 *   Mining and building are what STRATUM is primarily about (the project owner's own
 *   framing) — mining already has its own reward (src/mining-streak.js, a short-term
 *   active-pace bonus). This module is building's equivalent, but shaped like
 *   src/holder-bonus.js instead: not a pace signal, a STANDING-INVESTMENT signal. The
 *   more structures you have built and still own right now, the bigger a multiplier is
 *   applied to every gold/token reward src/rewards.js hands you. Deliberately the
 *   simplest possible hook, same as holder-bonus: no separate claim step, no lifetime
 *   ledger — just owning more structures right now moves you up a tier.
 *
 * WHY "CURRENTLY OWNED", NOT A LIFETIME TOTAL
 *   Mirrors holder-bonus.js's own "holding right now, not ever having held" shape on
 *   purpose. A wall you tore down stops blocking movement; a kiln you released stops
 *   producing gold. It would be inconsistent for a demolished structure to still be
 *   quietly inflating your yield forever after — the bonus tracks your ACTIVE colony,
 *   the same way holder-bonus tracks your CURRENT wallet balance, not your peak one.
 *
 * WHY THE TIER CEILING MATCHES HOLDER-BONUS'S EXACTLY (1.00 -> 1.10 -> 1.25 -> 1.50 -> 2.00)
 *   That symmetry is deliberate, not a coincidence of copying the file shape. Holder-bonus
 *   is the one thing in this economy that can be bought; builder-bonus is earned purely by
 *   playing, free, no wallet required. Capping both at the same 2.00x means the free path
 *   can fully match the pay path — living proof of README's "Play first" framing and the
 *   guide's "No purchase necessary" line, not just marketing copy.
 *
 * WHY THIS MODULE NEVER TOUCHES THE DATABASE ITSELF
 *   Same discipline as every other module in src/: 100% pure math over whatever count the
 *   caller hands it. It is the caller's (server.js, wired separately, NOT this module) job
 *   to decide how "structures currently owned" is counted (a `COUNT(*) ... WHERE owner=?`
 *   query against the `structures` table's existing `structures_owner` index) and how
 *   often to refresh it — see server.js's refreshBuilderBonus() for why that refresh is
 *   event-driven (on build/release) rather than recomputed on every single reward action,
 *   which would reintroduce the exact per-action DB-read cost this project already found
 *   and fixed once for src/anti-cheat.js's pending aggregates.
 *
 * CONTRACT — same shape as every other module in src/:
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.BuilderBonus = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh values (or a shared frozen tier reference) and never
 *     mutates its arguments.
 *   - Integer math for reward amounts, same "floor, never round up, never reduce below
 *     the original" convention as holder-bonus.js's boostedAmount.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.BuilderBonus = api;
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

  /** No-bonus baseline — every player starts here, including one with zero structures
   *  or a malformed/unreadable count. Named for flavor consistency with the tiers below. */
  var BASE_MULTIPLIER = 1.0;

  // ======================================================================
  // the tier table — ascending by minStructures, ceiling matched to holder-bonus.js
  // ======================================================================

  /** Frozen, ascending by minStructures. `tierFor` returns these exact object references
   *  (never a clone) so callers can compare tiers by identity if they want to. */
  var TIERS = deepFreeze([
    { minStructures: 0, multiplier: 1.00, name: 'Settler' },
    { minStructures: 2, multiplier: 1.10, name: 'Builder' },
    { minStructures: 5, multiplier: 1.25, name: 'Architect' },
    { minStructures: 10, multiplier: 1.50, name: 'Engineer' },
    { minStructures: 20, multiplier: 2.00, name: 'Overseer' }
  ]);

  /**
   * The tier for a given count of currently-owned structures. Walks TIERS from the top
   * down and returns the highest tier whose minStructures the count clears. Malformed
   * input (non-number, NaN, Infinity, negative, non-integer) always resolves to the base
   * Settler tier — never throws, never returns undefined. Returns the actual frozen tier
   * object from TIERS, not a copy.
   */
  function tierFor(count) {
    if (!isNonNegInt(count)) return TIERS[0];
    var best = TIERS[0];
    for (var i = 0; i < TIERS.length; i++) {
      if (count >= TIERS[i].minStructures) best = TIERS[i];
    }
    return best;
  }

  /** Convenience wrapper: just the multiplier number for a given structure count. */
  function multiplierFor(count) {
    return tierFor(count).multiplier;
  }

  /**
   * Apply a multiplier to a whole-unit reward amount, flooring the product. Guarantees:
   *   - never returns less than `amount` (a malformed/sub-1.0 multiplier is clamped up
   *     to 1.0 rather than ever shrinking a reward — this module only ever rewards
   *     building, never punishes it).
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
    TIERS: TIERS,                   // frozen, ascending by minStructures.
    tierFor: tierFor,               // { minStructures, multiplier, name } for a count.
    multiplierFor: multiplierFor,   // just the multiplier number for a count.
    boostedAmount: boostedAmount,   // floor(amount * clamped-multiplier), never < amount.
    boostedReward: boostedReward    // { gold, token } with boostedAmount applied to both.
  };
});
