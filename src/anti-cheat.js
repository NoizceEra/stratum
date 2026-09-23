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
 * WHAT THIS DETECTS (five signals — see suspicionDelta())
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
 *      guarantee here).
 *   4. LEDGER VELOCITY — pending STRM for this key growing >3× the median pending among
 *      active players (1-hour window). Amplifier only — alone it contributes nothing; it
 *      catches a slow-bot that stays under RATE/RHYTHM thresholds but accumulates rewards
 *      faster than the population. Fully reversible: pending balances decay toward median
 *      whenever earning stops, so this is a rolling signal, not a ledger mark.
 *   5. IP PENDING CONCENTRATION — the set of players on one IP holds >40% of world-total
 *      pending. Amplifier only — captures a farm distributed across keys but concentrated
 *      on one address/outlet. Same structural guarantee as (3): never throttles alone.
 *   RATE and RHYTHM combine additively into one score (suspicionDelta); the three
 *   amplifiers add atop them only when at least one primary signal has fired. The score
 *   decays continuously (decay()) so sustained normal play always returns to zero — this
 *   is a rolling behavioral signal, never a permanent mark.
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
  // signal 4: LEDGER VELOCITY — per-key pending-STRM growth vs. median (amplifier only)
  // ======================================================================

  /** Pending growth is suspicious only when it exceeds this multiple of the median
   *  pending among active players. 3x mirrors the "track pending STRM per key per hour"
   *  brief and is deliberately generous — a legitimate grinder who simply plays more
   *  than average is not flagged; only a key meaningfully outpacing the population is. */
  var LEDGER_VELOCITY_FACTOR = 3;
  /** Window over which velocity is evaluated. Nominally 1 hour — callers track the
   *  per-key pending delta over this window and supply `pendingForKey` vs.
   *  `medianPending` to the check below. This constant documents the intended window
   *  and is used by the optional in-memory velocity tracker further down. */
  var LEDGER_VELOCITY_WINDOW_MS = 3600000;

  /**
   * True when a single player's pending STRM meaningfully outpaces the population
   * median — `pendingForKey > median * LEDGER_VELOCITY_FACTOR`.
   * Amplifier only (see suspicionDelta): contributes nothing unless RATE or RHYTHM
   * has already fired, so a high-but-human-rate earner is never throttled by this alone.
   * Pure: no clock, no I/O.
   */
  function ledgerVelocitySuspicious(pendingForKey, medianPending) {
    return isNum(pendingForKey) && isNum(medianPending) &&
      medianPending > 0 && pendingForKey > 0 &&
      pendingForKey > medianPending * LEDGER_VELOCITY_FACTOR;
  }

  // ======================================================================
  // signal 5: IP PENDING CONCENTRATION — one IP owns >40% of total pending (amplifier)
  // ======================================================================

  /** One IP's players holding this share of world-total pending is flagged. 40% is
   *  deliberately high — a household of legitimate grinders should not trigger — so
   *  this only fires for a concentrated farm. Amplifier only, same reason as IP density. */
  var IP_PENDING_THRESHOLD = 0.40;

  /**
   * True when ipPending / totalPending exceeds IP_PENDING_THRESHOLD.
   * Pure; inputs are caller-supplied aggregates so this module stays clock- and DB-free.
   */
  function ipPendingConcentrationSuspicious(ipPending, totalPending) {
    return isNum(ipPending) && isNum(totalPending) &&
      totalPending > 0 && ipPending > 0 &&
      (ipPending / totalPending) > IP_PENDING_THRESHOLD;
  }

  /**
   * Median of a numeric array (NaN/Infinity/-ve entries ignored). Returns 0 when no
   * valid sample exists — callers treat 0 median as "insufficient population data"
   * and ledgerVelocitySuspicious() then returns false (no flag on unknown population).
   * Pure helper for the optional in-memory ledger-velocity tracker and for tests.
   */
  function medianOf(values) {
    if (!Array.isArray(values) || !values.length) return 0;
    var nums = [];
    for (var i = 0; i < values.length; i++) {
      if (isNum(values[i]) && values[i] >= 0) nums.push(values[i]);
    }
    if (!nums.length) return 0;
    nums.sort(function (a, b) { return a - b; });
    var mid = Math.floor(nums.length / 2);
    if (nums.length % 2 === 1) return nums[mid];
    return (nums[mid - 1] + nums[mid]) / 2;
  }

  // ----------------------------------------------------------------------
  // Optional in-memory ledger-velocity tracker (decays like the main score).
  // Kept here so anti-cheat.js remains zero-dep and callers can opt into a
  // server-side per-key pending history without reinventing the window logic.
  // Fully reversible: entries decay continuously via DECAY_PER_MS's window
  // analogue (LEDGER_VELOCITY_WINDOW_MS) and never persist — `clear()` resets
  // the whole view. The pure checks above remain the testable contract; this
  // tracker is a convenience that the server may ignore and supply its own
  // aggregates instead (see server.js's ledgerVelocityByKey path).
  // ----------------------------------------------------------------------
  var ledgerPendingSnapshot = new Map(); // key -> { pending, at }
  /** Record pending for `key` at time `now`. Pure timestamp, no clock. */
  function trackPending(key, pending, now) {
    if (typeof key !== 'string' || !key || !isNum(pending) || !isNum(now)) return;
    ledgerPendingSnapshot.set(key, { pending: pending, at: now });
    // Opportunistic prune: drop entries older than the window so the map never grows
    // unbounded if keys churn. Same "drops anything older than WINDOW_MS" shape as
    // trackAction(), but on a 1-hour horizon rather than 10 seconds.
    for (var _it = ledgerPendingSnapshot.entries(), _kv = _it.next(); !_kv.done; _kv = _it.next()) {
      var _k = _kv.value[0], _v = _kv.value[1];
      if (now - _v.at > LEDGER_VELOCITY_WINDOW_MS) ledgerPendingSnapshot.delete(_k);
    }
  }
  function pendingForKey(key) {
    var v = ledgerPendingSnapshot.get(key);
    return v ? v.pending : 0;
  }
  function clearPendingTracker() { ledgerPendingSnapshot.clear(); }
  /** Median pending across all currently tracked keys (0 when empty). */
  function medianPending() {
    var vals = [];
    ledgerPendingSnapshot.forEach(function (v) { vals.push(v.pending); });
    return medianOf(vals);
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
  /** Ledger velocity and IP-pending-concentration are likewise AMPLIFIER-only, for the
   *  same linear-decay reason documented above. Either alone, forever, would eventually
   *  out-accumulate the fixed DECAY_PER_MS — only structurally gating them on
   *  (rate || rhythm) keeps a legitimate high-but-human-rate grinder from slowly
   *  accumulating a throttle purely from holding more pending STRM than the median, or
   *  from sharing an IP with many earners who together dominate the pending pool. */
  var WEIGHT_LEDGER_VELOCITY = 3;
  var WEIGHT_IP_PENDING = 3;
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
   * `flags` is { rate, rhythm, ipDense, ledgerVelocity, ipPendingConcentration } — any
   * missing/falsy key contributes nothing. ledgerVelocity and ipPendingConcentration are
   * AMPLIFIER-ONLY (same structural guarantee as ipDense): they add nothing unless
   * rate || rhythm has already fired, so they alone can never throttle.
   */
  function suspicionDelta(flags) {
    var f = flags || {};
    var d = 0;
    if (f.rate) d += WEIGHT_RATE;
    if (f.rhythm) d += WEIGHT_RHYTHM;
    // Amplifier only — see WEIGHT_IP_DENSITY's comment for why this can never fire on its
    // own, structurally, regardless of how the weight is tuned.
    if (f.ipDense && (f.rate || f.rhythm)) d += WEIGHT_IP_DENSITY;
    if (f.ledgerVelocity && (f.rate || f.rhythm)) d += WEIGHT_LEDGER_VELOCITY;
    if (f.ipPendingConcentration && (f.rate || f.rhythm)) d += WEIGHT_IP_PENDING;
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
   * score by elapsed time, tracks the new action, evaluates all signals, adds the
   * resulting delta, and reports whether the NEW score means this action's reward should
   * be throttled. Pure — returns a fresh { history, score, throttled, flags } and never
   * mutates its arguments.
   *
   * Signals 1-2 (RATE, RHYTHM) are primary; 3-5 (IP density, ledger velocity,
   * IP pending concentration) are amplifier-only and never throttle alone.
   *
   * @param prior       { history: number[], score: number, lastAt: number|null }
   * @param now         current time (caller's clock — never read internally)
   * @param ipAccountCount  distinct accounts seen recently from this action's IP (0 if unknown)
   * @param ledgerCtx   optional { pending, medianPending, ipPending, totalPending } for
   *                    the two ledger-derived amplifier signals. Omitted/null => both false.
   *                    Pure: caller supplies the aggregates so this module stays DB/clock-free.
   */
  function evaluate(prior, now, ipAccountCount, ledgerCtx) {
    var p = prior || {};
    var elapsed = (isNum(p.lastAt) && isNum(now)) ? Math.max(0, now - p.lastAt) : 0;
    var decayedScore = decay(p.score, elapsed);
    var history = trackAction(p.history, now);
    var lc = ledgerCtx && typeof ledgerCtx === 'object' ? ledgerCtx : {};
    var flags = {
      rate: rateExceeded(history, now),
      rhythm: rhythmSuspicious(history),
      ipDense: ipDensitySuspicious(ipAccountCount),
      ledgerVelocity: ledgerVelocitySuspicious(lc.pending, lc.medianPending),
      ipPendingConcentration: ipPendingConcentrationSuspicious(lc.ipPending, lc.totalPending)
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
    LEDGER_VELOCITY_FACTOR: LEDGER_VELOCITY_FACTOR,
    LEDGER_VELOCITY_WINDOW_MS: LEDGER_VELOCITY_WINDOW_MS,
    IP_PENDING_THRESHOLD: IP_PENDING_THRESHOLD,
    THROTTLE_THRESHOLD: THROTTLE_THRESHOLD,
    DECAY_PER_MS: DECAY_PER_MS,
    MAX_SCORE: MAX_SCORE,
    WEIGHT_RATE: WEIGHT_RATE,
    WEIGHT_RHYTHM: WEIGHT_RHYTHM,
    WEIGHT_IP_DENSITY: WEIGHT_IP_DENSITY,
    WEIGHT_LEDGER_VELOCITY: WEIGHT_LEDGER_VELOCITY,
    WEIGHT_IP_PENDING: WEIGHT_IP_PENDING,
    trackAction: trackAction,             // new history array with `now` recorded
    actionRate: actionRate,               // count of recent actions
    rateExceeded: rateExceeded,           // bool
    intervalStats: intervalStats,         // { mean, stddev, cv, samples } | null
    rhythmSuspicious: rhythmSuspicious,   // bool
    ipDensitySuspicious: ipDensitySuspicious, // bool
    ledgerVelocitySuspicious: ledgerVelocitySuspicious,
    ipPendingConcentrationSuspicious: ipPendingConcentrationSuspicious,
    medianOf: medianOf,
    trackPending: trackPending,
    pendingForKey: pendingForKey,
    clearPendingTracker: clearPendingTracker,
    medianPending: medianPending,
    suspicionDelta: suspicionDelta,       // points to add for one action's flags
    decay: decay,                         // score after elapsed time
    shouldThrottle: shouldThrottle,       // bool
    evaluate: evaluate                    // the one-call convenience wrapper above
  };
});
