/**
 * mining-streak.js — a growing yield multiplier for steady, human, ACTIVE mining.
 *
 * WHY THIS FILE EXISTS
 *   Mining/harvesting is the primary thing a player does in STRATUM (the project owner's
 *   own framing). Right now every mine action pays the same flat yield whether a player
 *   is glued to the screen working a steady rhythm or clicking once every few minutes
 *   between AFK stretches. That leaves nothing on the table to reward genuine engagement.
 *   This module is that reward: a per-player "streak" that builds while a player keeps
 *   mining at a believable, sustained human pace, and grants a small, capped multiplier
 *   on top of whatever the underlying action already pays. It is a carrot, never a stick —
 *   nothing here ever reduces a reward below its base amount.
 *
 * WHY THE PACING WINDOW LOOKS THE WAY IT DOES (read src/anti-cheat.js first)
 *   src/anti-cheat.js runs a SEPARATE, server-side bot-detection pass over the exact same
 *   stream of reward-earning actions. It flags RATE (more than 25 actions inside a
 *   rolling 10s window, i.e. faster than ~2.5/sec sustained) and RHYTHM (near-perfectly
 *   uniform inter-action timing, coefficient of variation <= 0.08). If this module
 *   rewarded players for mining as fast as possible, it would actively push legitimate
 *   players toward anti-cheat's RATE ceiling — the two systems would be fighting each
 *   other, with the player caught in the middle. So the sweet spot here (MIN_GAP_MS..
 *   MAX_GAP_MS, see below) is deliberately centered far inside anti-cheat's normal-pacing
 *   territory: roughly one action every 1-15 seconds, nowhere near either threshold, and
 *   there is no reward anywhere in this module for going faster than that floor — an
 *   action faster than MIN_GAP_MS earns nothing extra, it just doesn't get punished either.
 *   Real human timing has natural jitter (reaction time, looking away, re-aiming), which
 *   keeps a genuine player's coefficient of variation well above RHYTHM_CV_FLOOR on its
 *   own; this module does not need to (and does not) model that separately.
 *
 * CONTRACT — same shape as every other module in src/:
 *   - Dependency-free UMD. No require() of other project files, no DOM, no I/O.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(). Every timestamp is a
 *     `now` argument the caller supplies (exactly src/anti-cheat.js's "the caller owns the
 *     clock" pattern) — this module is testable without a clock and never drifts from the
 *     server's own notion of time.
 *   - Integer math for reward amounts; the multiplier itself is a float and is only ever
 *     applied by FLOORING (src/token-sink.js's splitBurn convention: floor, never round up,
 *     never silently lose the underlying whole-unit guarantee).
 *   - Every helper returns fresh values, never mutates its arguments, never throws on
 *     garbage input.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.MiningStreak = api;
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

  // ======================================================================
  // pacing constants — the "sweet spot" window a streak-extending action must land in
  // ======================================================================

  /** An action faster than this since the player's last one does NOT extend the streak —
   *  it's treated as the same "beat," neither building nor breaking it. 900ms sits well
   *  above realistic instant-double-click/network-retry noise (a genuine second input in
   *  under a second is almost always a duplicate event, not a new deliberate action) while
   *  staying comfortably below anti-cheat's RATE ceiling of ~400ms/action (25 per 10s).
   *  There is deliberately no way to farm the multiplier faster by clicking faster than
   *  this — the fastest way to build streak is also a normal human pace. */
  var MIN_GAP_MS = 900;

  /** An action slower than this since the last one BREAKS the streak back down to a fresh
   *  1 (see evaluate() below — not all the way to 0, since a fresh action was still just
   *  taken). 18 seconds is deliberately forgiving: mining should feel like a rhythm a
   *  player can sustain while still glancing at a map, fighting off a wandering monster,
   *  or reading a chat message, not a twitch-timing minigame that punishes any pause. */
  var MAX_GAP_MS = 18000;

  /** Multiplier gained per streak step. 0.02 (+2%) per consecutive in-window action is
   *  small enough per-action that no single mine ever feels swingy, but accumulates into
   *  a meaningful bonus over a sustained session. */
  var STEP_BONUS = 0.02;

  /** Hard cap on the total bonus: +50%, so the multiplier tops out at 1.50x. At STEP_BONUS
   *  = 0.02 that's reached at streak 25 — at the middle of the sweet-spot pace (roughly one
   *  action every ~9s, the midpoint of 900ms..18000ms) that's about 25 * 9s =~ 3.75 minutes
   *  of continuous, steady mining to hit the ceiling, and it holds flat from there rather
   *  than growing without bound for however long a session runs. */
  var MAX_BONUS = 0.5;

  var BASE_MULTIPLIER = 1.0;

  // ======================================================================
  // multiplier math
  // ======================================================================

  /**
   * Multiplier for a given streak count: 1.0 + min(MAX_BONUS, streak * STEP_BONUS).
   * Malformed/negative streak -> exactly BASE_MULTIPLIER (1.0), never throws.
   */
  function multiplierForStreak(streak) {
    var s = isNonNegInt(streak) ? streak : 0;
    return BASE_MULTIPLIER + Math.min(MAX_BONUS, s * STEP_BONUS);
  }

  // ======================================================================
  // evaluate() — the main entry point, mirrors AntiCheat.evaluate's calling convention
  // ======================================================================

  /**
   * Advance a player's streak state given their prior state and the current time.
   *
   * @param prior  { streak: number, lastAt: number|null } — the caller's persisted state.
   *               null, malformed, or missing fields are treated as a fresh player
   *               ({ streak: 0, lastAt: null }); never throws.
   * @param now    current time (caller's clock — never read internally). Malformed/NaN
   *               `now` is treated as "no valid timestamp this call" and the streak is
   *               left unchanged (still returns a well-formed result, never throws).
   *
   * Returns a FRESH { streak, lastAt, multiplier }:
   *   - lastAt === null (first ever tracked action) -> streak becomes 1 (their first
   *     action; no special-case crash, no reward for doing nothing).
   *   - gap < MIN_GAP_MS -> streak UNCHANGED (too fast to count, not punished either).
   *   - gap > MAX_GAP_MS -> streak resets to 1 (paused too long, but this action still
   *     counts as one fresh mine, not zero).
   *   - MIN_GAP_MS <= gap <= MAX_GAP_MS (inclusive both ends — the sweet spot) -> streak
   *     increments by 1.
   *   - multiplier is multiplierForStreak(new streak), capped at 1 + MAX_BONUS.
   */
  function evaluate(prior, now) {
    var p = (prior && typeof prior === 'object') ? prior : {};
    var priorStreak = isNonNegInt(p.streak) ? p.streak : 0;
    var priorLastAt = isNum(p.lastAt) ? p.lastAt : null;
    var validNow = isNum(now);

    if (!validNow) {
      // No usable clock reading this call — leave the streak exactly as it was.
      return {
        streak: priorStreak,
        lastAt: priorLastAt,
        multiplier: multiplierForStreak(priorStreak)
      };
    }

    var newStreak;
    if (priorLastAt === null) {
      // First ever tracked action for this player.
      newStreak = 1;
    } else {
      var gap = now - priorLastAt;
      if (!isNum(gap) || gap < 0) {
        // Clock went backwards or produced garbage — treat conservatively as "too fast to
        // count" rather than breaking or crediting a streak off of nonsense timing.
        newStreak = priorStreak;
      } else if (gap < MIN_GAP_MS) {
        newStreak = priorStreak;
      } else if (gap > MAX_GAP_MS) {
        newStreak = 1;
      } else {
        newStreak = priorStreak + 1;
      }
    }

    return {
      streak: newStreak,
      lastAt: now,
      multiplier: multiplierForStreak(newStreak)
    };
  }

  // ======================================================================
  // applying the multiplier to a reward — floors, never reduces below the original
  // ======================================================================

  /**
   * amount boosted by `multiplier`, floored. Malformed/non-finite multiplier is treated
   * as 1.0 (no change). Malformed/negative amount treated as 0. Never reduces a reward
   * below its original integer amount (a multiplier < 1.0, however it got here, is
   * clamped up to 1.0 — this module never shrinks a reward).
   */
  function boostedAmount(amount, multiplier) {
    var a = isNonNegInt(amount) ? amount : 0;
    var m = isNum(multiplier) && multiplier > 0 ? multiplier : BASE_MULTIPLIER;
    if (m < BASE_MULTIPLIER) m = BASE_MULTIPLIER;
    return Math.floor(a * m);
  }

  /**
   * { gold, token } reward boosted by `multiplier`, each field floored independently via
   * boostedAmount. Malformed/missing fields on `reward` are treated as 0. Never throws.
   */
  function boostedReward(reward, multiplier) {
    var r = (reward && typeof reward === 'object') ? reward : {};
    return {
      gold: boostedAmount(r.gold, multiplier),
      token: boostedAmount(r.token, multiplier)
    };
  }

  return deepFreeze({
    MIN_GAP_MS: MIN_GAP_MS,
    MAX_GAP_MS: MAX_GAP_MS,
    STEP_BONUS: STEP_BONUS,
    MAX_BONUS: MAX_BONUS,
    BASE_MULTIPLIER: BASE_MULTIPLIER,
    evaluate: evaluate,                       // { streak, lastAt, multiplier }
    multiplierForStreak: multiplierForStreak, // float, capped at 1 + MAX_BONUS
    boostedAmount: boostedAmount,             // floored integer, never below original
    boostedReward: boostedReward              // { gold, token } floored, never below original
  });
});
