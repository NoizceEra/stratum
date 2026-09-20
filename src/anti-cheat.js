/**
 * anti-cheat.js — automatic, non-discretionary detection of economic abuse (bot
 * harvesting, macro scripting, multi-accounting) against reward-earning actions.
 *
 * WHY THIS EXISTS NOW, AND WHY IT LOOKS LIKE THIS
 *   ROADMAP.md is explicit that STRATUM has no admins and no moderation queue — nobody
 *   reviews a report and decides to ban someone. That was a fine, deliberate design when
 *   STRM was just a number going up. Now that chain-adapter.js can really sign and
 *   broadcast a transfer (still gated off today, see its own header), a harvest-botting
 *   or multi-accounting script becomes a direct financial exploit, not a leaderboard
 *   nuisance — "no admins" can no longer mean "no defense." It has to mean the defense is
 *   entirely automatic and reversible: a rolling suspicion score, computed fresh from
 *   recent behavior, that decays back toward zero on its own and whose only consequence
 *   is throttling the ECONOMIC REWARD of an action. It never blocks the action itself,
 *   never bans, never locks anyone out, and never needs a human to review or undo
 *   anything. A false positive costs a legitimate player a few seconds of zero-reward
 *   actions, not their account.
 *
 * WHAT THIS DETECTS (three signals — see suspicionDelta())
 *   1. RATE — more reward-earning actions in a short rolling window than a human clicking
 *      a UI can plausibly produce.
 *   2. RHYTHM — suspiciously UNIFORM timing between actions. Real human input has natural
 *      jitter; a script firing on a fixed interval does not. Measured as the coefficient
 *      of variation (stddev / mean) of the gaps between consecutive actions — a value near
 *      zero is machine-like regularity a human does not produce by hand.
 *   3. IP DENSITY — many distinct accounts earning from the same IP address at once. A
 *      soft signal ONLY — shared networks, NAT, campus/office wifi are all real and
 *      innocent — so it is structurally an AMPLIFIER, never an independent source: it
 *      contributes nothing unless RATE or RHYTHM has already fired on the same action (see
 *      WEIGHT_IP_DENSITY's comment for why "weighted low" alone isn't a strong enough
 *      guarantee here). RATE and RHYTHM combine additively into one score (suspicionDelta),
 *      and the score decays continuously (decay()) so sustained normal play always returns
 *      to zero — this is a rolling behavioral signal, never a permanent mark.
 *
 * CONTRACT — same as every other module in src/:
 *   - Dependency-free UMD. No require of other project files, no DOM, no I/O.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(). Every timestamp is a
 *     `now` argument supplied by the caller, so this module is testable without a clock
 *     and never drifts from the server's own notion of time.
 *   - Every helper returns fresh values and never mutates its arguments.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.AntiCheat = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function isPosInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0; }

  // ======================================================================
  // action history — a bounded, time-windowed list of "when did a reward-earning
  // action last happen" timestamps, kept per player by the caller (server.js).
  // ======================================================================

  /** Longest history kept per player, regardless of timing — bounds memory even if the
   *  window math below is ever misconfigured. */
  var HISTORY_MAX = 40;
  /** Rolling window used for both the rate check and the rhythm check. */
  var WINDOW_MS = 10000;

  /**
   * Record one reward-earning action at time `now`. Returns a NEW history array — never
   * mutates `history`. Drops anything older than WINDOW_MS and anything beyond
   * HISTORY_MAX entries (oldest first), so this never grows unbounded across a long
   * session even if the caller never separately prunes it.
   */
  function trackAction(history, now) {
    var h = Array.isArray(history) ? history.slice() : [];
    if (!isNum(now)) return h;
    h.push(now);
    h = h.filter(function (t) { return isNum(t) && now - t <= WINDOW_MS; });
    if (h.length > HISTORY_MAX) h = h.slice(h.length - HISTORY_MAX);
    h.sort(function (a, b) { return a - b; });
    return h;
  }

  // ======================================================================
  // signal 1: RATE
  // ======================================================================

  /** More than this many reward-earning actions inside WINDOW_MS is flagged. Chosen
   *  generously (2.5/sec sustained) so a genuinely fast, skilled human player is not
   *  routinely flagged — the consequence (a temporary reward throttle, never a block) is
   *  low-stakes enough that erring toward under-flagging real play is the right trade. */
  var RATE_MAX_PER_WINDOW = 25;

  /** Count of `history` entries within WINDOW_MS of `now` (inclusive). */
  function actionRate(history, now) {
    if (!Array.isArray(history) || !isNum(now)) return 0;
    var n = 0;
    for (var i = 0; i < history.length; i++) if (now - history[i] <= WINDOW_MS) n++;
    return n;
  }

  function rateExceeded(history, now) {
    return actionRate(history, now) > RATE_MAX_PER_WINDOW;
  }

  // ======================================================================
  // signal 2: RHYTHM (macro-like timing uniformity)
  // ======================================================================

  /** Need at least this many actions in the window before rhythm is even evaluated — a
   *  coefficient of variation from 2-3 samples is noise, not a signal. */
  var RHYTHM_MIN_SAMPLES = 6;
  /** Coefficient of variation (stddev / mean of inter-action gaps) at or below this is
   *  treated as machine-regular. Real human clicking/keying virtually never lands this
   *  tight even when someone is trying to be consistent. */
  var RHYTHM_CV_FLOOR = 0.08;

  /**
   * { mean, stddev, cv, samples } of the gaps between consecutive timestamps in `history`
   * (already expected sorted ascending — trackAction() keeps it that way), or null if
   * there are fewer than RHYTHM_MIN_SAMPLES gaps to measure.
   */
  function intervalStats(history) {
    if (!Array.isArray(history) || history.length < RHYTHM_MIN_SAMPLES + 1) return null;
    var gaps = [];
    for (var i = 1; i < history.length; i++) {
      var g = history[i] - history[i - 1];
      if (isNum(g) && g >= 0) gaps.push(g);
    }
    if (gaps.length < RHYTHM_MIN_SAMPLES) return null;
    var sum = 0;
    for (var j = 0; j < gaps.length; j++) sum += gaps[j];
    var mean = sum / gaps.length;
    if (mean <= 0) return { mean: mean, stddev: 0, cv: 0, samples: gaps.length };
    var variance = 0;
    for (var k = 0; k < gaps.length; k++) variance += Math.pow(gaps[k] - mean, 2);
    variance = variance / gaps.length;
    var stddev = Math.sqrt(variance);
    return { mean: mean, stddev: stddev, cv: stddev / mean, samples: gaps.length };
  }

  function rhythmSuspicious(history) {
    var s = intervalStats(history);
    return !!s && s.cv <= RHYTHM_CV_FLOOR;
  }

  // ======================================================================
  // signal 3: IP DENSITY (soft signal — see the file header)
  // ======================================================================

  /** Distinct accounts earning from one IP at/above this count contributes the (low)
   *  density signal. Deliberately generous — shared networks are common and innocent. */
  var IP_DENSITY_THRESHOLD = 5;

  function ipDensitySuspicious(distinctAccountCount) {
    return isPosInt(distinctAccountCount) && distinctAccountCount >= IP_DENSITY_THRESHOLD;
  }

  // ======================================================================
  // combining signals into one rolling score
  // ======================================================================

  /** Points added per action where each signal is true. */
  var WEIGHT_RATE = 6;
  var WEIGHT_RHYTHM = 6;
  /** IP density is an AMPLIFIER, not an independent source — see suspicionDelta() below.
   *  It contributes nothing on its own, only as an aggravating factor when rate or rhythm
   *  has already fired. This is deliberate, not just tuned: decay() below is LINEAR (a
   *  fixed points-per-millisecond subtraction), not proportional to the current score, so
   *  ANY standalone signal with a nonzero weight that fires on every action will eventually
   *  out-accumulate a fixed decay rate over a long enough session, no matter how small the
   *  weight — there is no tuning that makes "alone, forever" safe under linear decay, only
   *  structurally excluding it from standalone accumulation does. Shared networks, NAT, and
   *  campus/office wifi are real and innocent; this signal must never be able to throttle
   *  someone by itself, so it structurally can't. */
  var WEIGHT_IP_DENSITY = 3;
  /** Score at/above this throttles the economic reward of the action that pushed it here.
   *  Two simultaneous signals (12) crosses it in a single action; rate alone crosses it
   *  within two consecutive flagged actions (12) — sustained abuse, not a single blip. */
  var THROTTLE_THRESHOLD = 10;
  /** Score decays fully within about a minute of returning to normal behavior — this is a
   *  rolling signal, not a punishment ledger. */
  var DECAY_PER_MS = THROTTLE_THRESHOLD / 60000;
  /** Hard ceiling on the score, regardless of how long or how hard abuse continues. Without
   *  a cap, a bot left running for a long session could accumulate a score that takes an
   *  absurdly long time to decay back to zero after it stops — that would turn a rolling
   *  behavioral signal into an effective punishment ledger, exactly what this module is
   *  designed not to be. Capped at 3x the throttle threshold: comfortably distinguishable
   *  from "just throttled," but still fully decays within a few minutes of normal play. */
  var MAX_SCORE = THROTTLE_THRESHOLD * 3;

  /**
   * Points to ADD to a player's suspicion score for one action, given which signals fired.
   * `flags` is { rate, rhythm, ipDense } — any missing/falsy key contributes nothing.
   */
  function suspicionDelta(flags) {
    var f = flags || {};
    var d = 0;
    if (f.rate) d += WEIGHT_RATE;
    if (f.rhythm) d += WEIGHT_RHYTHM;
    // Amplifier only — see WEIGHT_IP_DENSITY's comment for why this can never fire on its
    // own, structurally, regardless of how the weight is tuned.
    if (f.ipDense && (f.rate || f.rhythm)) d += WEIGHT_IP_DENSITY;
    return d;
  }

  /** `score` reduced by elapsed time since it was last touched, floored at 0. Never
   *  negative, never throws on garbage input. */
  function decay(score, elapsedMs) {
    var s = isNum(score) && score > 0 ? score : 0;
    var e = isNum(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    return Math.max(0, s - e * DECAY_PER_MS);
  }

  function shouldThrottle(score) {
    return isNum(score) && score >= THROTTLE_THRESHOLD;
  }

  /**
   * One call, everything a caller needs for one reward-earning action: decays the prior
   * score by elapsed time, tracks the new action, evaluates all three signals, adds the
   * resulting delta, and reports whether the NEW score means this action's reward should
   * be throttled. Pure — returns a fresh { history, score, throttled, flags } and never
   * mutates its arguments.
   *
   * @param prior       { history: number[], score: number, lastAt: number|null }
   * @param now         current time (caller's clock — never read internally)
   * @param ipAccountCount  distinct accounts seen recently from this action's IP (0 if unknown)
   */
  function evaluate(prior, now, ipAccountCount) {
    var p = prior || {};
    var elapsed = (isNum(p.lastAt) && isNum(now)) ? Math.max(0, now - p.lastAt) : 0;
    var decayedScore = decay(p.score, elapsed);
    var history = trackAction(p.history, now);
    var flags = {
      rate: rateExceeded(history, now),
      rhythm: rhythmSuspicious(history),
      ipDense: ipDensitySuspicious(ipAccountCount)
    };
    var score = Math.min(MAX_SCORE, decayedScore + suspicionDelta(flags));
    return {
      history: history,
      score: score,
      lastAt: isNum(now) ? now : p.lastAt || null,
      throttled: shouldThrottle(score),
      flags: flags
    };
  }

  return {
    HISTORY_MAX: HISTORY_MAX,
    WINDOW_MS: WINDOW_MS,
    RATE_MAX_PER_WINDOW: RATE_MAX_PER_WINDOW,
    RHYTHM_MIN_SAMPLES: RHYTHM_MIN_SAMPLES,
    RHYTHM_CV_FLOOR: RHYTHM_CV_FLOOR,
    IP_DENSITY_THRESHOLD: IP_DENSITY_THRESHOLD,
    THROTTLE_THRESHOLD: THROTTLE_THRESHOLD,
    DECAY_PER_MS: DECAY_PER_MS,
    MAX_SCORE: MAX_SCORE,
    trackAction: trackAction,             // new history array with `now` recorded
    actionRate: actionRate,               // count of recent actions
    rateExceeded: rateExceeded,           // bool
    intervalStats: intervalStats,         // { mean, stddev, cv, samples } | null
    rhythmSuspicious: rhythmSuspicious,   // bool
    ipDensitySuspicious: ipDensitySuspicious, // bool
    suspicionDelta: suspicionDelta,       // points to add for one action's flags
    decay: decay,                         // score after elapsed time
    shouldThrottle: shouldThrottle,       // bool
    evaluate: evaluate                    // the one-call convenience wrapper above
  };
});
