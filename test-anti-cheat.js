/* test-anti-cheat.js — assertions for src/anti-cheat.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const AC = require('./src/anti-cheat.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- trackAction()
check('trackAction-appends-and-returns-new-array', (function () {
  const h1 = [];
  const h2 = AC.trackAction(h1, 1000);
  return h1.length === 0 && h2.length === 1 && h2[0] === 1000;
})());
check('trackAction-drops-entries-older-than-WINDOW_MS', (function () {
  const h = AC.trackAction([0], AC.WINDOW_MS + 1);
  return h.indexOf(0) === -1 && h.indexOf(AC.WINDOW_MS + 1) >= 0;
})());
check('trackAction-keeps-entries-within-WINDOW_MS', (function () {
  const h = AC.trackAction([0], AC.WINDOW_MS);
  return h.indexOf(0) >= 0;
})());
check('trackAction-caps-at-HISTORY_MAX', (function () {
  let h = [];
  for (let i = 0; i < AC.HISTORY_MAX + 10; i++) h = AC.trackAction(h, i);
  return h.length === AC.HISTORY_MAX;
})());
check('trackAction-sorted-ascending', (function () {
  const h = AC.trackAction(AC.trackAction(AC.trackAction([], 300), 100), 200);
  return h[0] <= h[1] && h[1] <= h[2];
})());
check('trackAction-bad-now-never-throws', (function () {
  const h = AC.trackAction([1, 2], 'nope');
  return Array.isArray(h);
})());
check('trackAction-bad-history-never-throws', Array.isArray(AC.trackAction(null, 5)));
check('trackAction-never-mutates-input', (function () {
  const h1 = [1];
  AC.trackAction(h1, 2);
  return h1.length === 1 && h1[0] === 1;
})());

// ---------------------------------------------------------------- RATE signal
check('actionRate-counts-within-window', (function () {
  const now = AC.WINDOW_MS + 900;
  const h = [0, 1000, 2000, AC.WINDOW_MS + 500]; // 0 is 10900ms ago (outside); the rest are within 10s
  return AC.actionRate(h, now) === 3;
})());
check('actionRate-zero-on-empty-history', AC.actionRate([], 1000) === 0);
check('actionRate-never-throws-on-garbage', AC.actionRate('nope', 1000) === 0);
check('rateExceeded-false-under-threshold', (function () {
  let h = [];
  for (let i = 0; i < AC.RATE_MAX_PER_WINDOW; i++) h = AC.trackAction(h, i * 100);
  return AC.rateExceeded(h, (AC.RATE_MAX_PER_WINDOW - 1) * 100) === false;
})());
check('rateExceeded-true-over-threshold', (function () {
  let h = [];
  const now0 = 0;
  for (let i = 0; i <= AC.RATE_MAX_PER_WINDOW + 5; i++) h = AC.trackAction(h, now0 + i * 10);
  return AC.rateExceeded(h, now0 + (AC.RATE_MAX_PER_WINDOW + 5) * 10) === true;
})());

// ---------------------------------------------------------------- RHYTHM signal
check('intervalStats-null-below-min-samples', AC.intervalStats([0, 100, 200]) === null);
check('intervalStats-null-on-empty', AC.intervalStats([]) === null);
check('intervalStats-real-stats-with-enough-samples', (function () {
  // 7 timestamps -> 6 gaps, all exactly 100ms apart: mean=100, stddev=0, cv=0
  const h = [0, 100, 200, 300, 400, 500, 600];
  const s = AC.intervalStats(h);
  return s && s.mean === 100 && s.stddev === 0 && s.cv === 0 && s.samples === 6;
})());
check('intervalStats-jittery-human-like-timing-has-real-cv', (function () {
  const h = [0, 340, 900, 1100, 1900, 2050, 3000]; // deliberately irregular
  const s = AC.intervalStats(h);
  return s && s.cv > AC.RHYTHM_CV_FLOOR;
})());
check('rhythmSuspicious-false-below-min-samples', AC.rhythmSuspicious([0, 100, 200]) === false);
check('rhythmSuspicious-true-for-perfectly-uniform-timing', (function () {
  const h = [0, 100, 200, 300, 400, 500, 600];
  return AC.rhythmSuspicious(h) === true;
})());
check('rhythmSuspicious-false-for-jittery-timing', (function () {
  const h = [0, 340, 900, 1100, 1900, 2050, 3000];
  return AC.rhythmSuspicious(h) === false;
})());
check('rhythmSuspicious-never-throws-on-garbage', AC.rhythmSuspicious('nope') === false);

// ---------------------------------------------------------------- IP DENSITY signal
check('ipDensitySuspicious-false-below-threshold', AC.ipDensitySuspicious(AC.IP_DENSITY_THRESHOLD - 1) === false);
check('ipDensitySuspicious-true-at-threshold', AC.ipDensitySuspicious(AC.IP_DENSITY_THRESHOLD) === true);
check('ipDensitySuspicious-false-on-garbage', AC.ipDensitySuspicious('nope') === false && AC.ipDensitySuspicious(-1) === false && AC.ipDensitySuspicious(0) === false);

// ---------------------------------------------------------------- suspicionDelta() / decay()
check('suspicionDelta-zero-when-nothing-flagged', AC.suspicionDelta({}) === 0);
check('suspicionDelta-zero-on-no-args', AC.suspicionDelta() === 0);
check('suspicionDelta-rate-and-rhythm-sum-additively', (function () {
  const rateOnly = AC.suspicionDelta({ rate: true });
  const rhythmOnly = AC.suspicionDelta({ rhythm: true });
  const both = AC.suspicionDelta({ rate: true, rhythm: true });
  return both === rateOnly + rhythmOnly && rateOnly > 0 && rhythmOnly > 0;
})());
check('suspicionDelta-ip-density-alone-contributes-NOTHING-structurally', (function () {
  // Not "weighted low" — literally zero, by construction, regardless of the weight
  // constant's value. See WEIGHT_IP_DENSITY's comment for why linear decay demands this.
  return AC.suspicionDelta({ ipDense: true }) === 0;
})());
check('suspicionDelta-ip-density-amplifies-an-existing-rate-violation', (function () {
  const rateOnly = AC.suspicionDelta({ rate: true });
  const rateWithIp = AC.suspicionDelta({ rate: true, ipDense: true });
  return rateWithIp > rateOnly;
})());
check('suspicionDelta-ip-density-amplifies-an-existing-rhythm-violation', (function () {
  const rhythmOnly = AC.suspicionDelta({ rhythm: true });
  const rhythmWithIp = AC.suspicionDelta({ rhythm: true, ipDense: true });
  return rhythmWithIp > rhythmOnly;
})());
check('decay-reduces-score-over-time', AC.decay(10, 1000) < 10);
check('decay-never-goes-negative', AC.decay(1, 1000000) === 0);
check('decay-zero-elapsed-is-a-no-op', AC.decay(10, 0) === 10);
check('decay-never-throws-on-garbage', AC.decay('nope', 'nope') === 0);
check('decay-fully-clears-a-threshold-score-in-about-a-minute', (function () {
  return AC.decay(AC.THROTTLE_THRESHOLD, 60000) === 0;
})());

// ---------------------------------------------------------------- shouldThrottle()
check('shouldThrottle-false-under-threshold', AC.shouldThrottle(AC.THROTTLE_THRESHOLD - 1) === false);
check('shouldThrottle-true-at-threshold', AC.shouldThrottle(AC.THROTTLE_THRESHOLD) === true);
check('shouldThrottle-false-on-garbage', AC.shouldThrottle('nope') === false);

// ---------------------------------------------------------------- evaluate() — the full wrapper
check('evaluate-fresh-player-never-throttled', (function () {
  const r = AC.evaluate({ history: [], score: 0, lastAt: null }, 1000, 0);
  return r.throttled === false && r.score === 0 && r.history.length === 1;
})());
check('evaluate-never-mutates-prior', (function () {
  const prior = { history: [1, 2], score: 5, lastAt: 100 };
  AC.evaluate(prior, 200, 0);
  return prior.history.length === 2 && prior.score === 5 && prior.lastAt === 100;
})());
check('evaluate-normal-human-paced-play-never-throttles', (function () {
  // one action roughly every 1.5-3s with real jitter, for a couple minutes
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  const gaps = [1500, 2200, 1800, 2600, 1400, 3000, 2100, 1900, 2400, 1700, 2000, 2800];
  let everThrottled = false;
  for (let i = 0; i < gaps.length; i++) {
    now += gaps[i];
    state = AC.evaluate(state, now, 1);
    if (state.throttled) everThrottled = true;
  }
  return everThrottled === false;
})());
check('evaluate-sustained-machine-regular-bursts-eventually-throttle', (function () {
  // a "bot": one action exactly every 50ms, way over rate AND perfectly uniform
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  let throttledAt = -1;
  for (let i = 0; i < 40; i++) {
    now += 50;
    state = AC.evaluate(state, now, 1);
    if (state.throttled && throttledAt === -1) throttledAt = i;
  }
  return throttledAt >= 0;
})());
check('evaluate-throttled-bot-flags-both-rate-and-rhythm', (function () {
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 50; state = AC.evaluate(state, now, 1); }
  return state.flags.rate === true && state.flags.rhythm === true;
})());
check('evaluate-score-hits-the-MAX_SCORE-ceiling-under-sustained-abuse', (function () {
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 50; state = AC.evaluate(state, now, 1); }
  return state.score === AC.MAX_SCORE;
})());
check('evaluate-score-decays-back-to-zero-after-abuse-stops', (function () {
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 50; state = AC.evaluate(state, now, 1); }
  const scoreRightAfterAbuse = state.score;
  // Capped at MAX_SCORE, so a bounded (a few minutes, not tens of minutes) quiet spell
  // fully clears it — this is a rolling signal, never an unbounded punishment ledger.
  const after = AC.evaluate(state, now + (AC.MAX_SCORE / AC.DECAY_PER_MS), 0);
  return scoreRightAfterAbuse === AC.MAX_SCORE && after.score === 0;
})());
check('evaluate-ip-density-alone-never-throttles', (function () {
  // plausible human pacing, but from a "busy" IP (5+ distinct accounts) — should stay
  // low-weight and never cross the throttle threshold on its own.
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  const gaps = [1800, 2200, 1900, 2600, 2000, 1700, 2400, 2100];
  for (let i = 0; i < gaps.length; i++) { now += gaps[i]; state = AC.evaluate(state, now, 10); }
  return state.throttled === false;
})());
check('evaluate-ip-density-alone-never-throttles-even-over-a-long-session', (function () {
  // 500 actions, ~1.5-2.5s apart (plausible sustained human pace), all from a "busy" IP.
  let state = { history: [], score: 0, lastAt: null };
  let now = 0;
  let everThrottled = false;
  for (let i = 0; i < 500; i++) {
    now += 1500 + (i % 5) * 250; // 1500..2500ms, deterministic pseudo-jitter
    state = AC.evaluate(state, now, 8);
    if (state.throttled) everThrottled = true;
  }
  return everThrottled === false;
})());
check('evaluate-bad-args-never-throw', (function () {
  const r = AC.evaluate(null, 'nope', 'nope');
  return typeof r === 'object' && r.throttled === false;
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/anti-cheat.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
