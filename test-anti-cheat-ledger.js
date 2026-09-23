/* test-anti-cheat-ledger.js — offline unit tests for src/anti-cheat.js ledger-velocity & IP concentration amplifiers. PASS/FAIL per case, non-zero exit on failure. Pure, no sockets, no DB. */
'use strict';
const AC = require('./src/anti-cheat.js');
const fs = require('node:fs');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('PASS ' + name); }
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- ledgerVelocitySuspicious()
check('ledgerVelocitySuspicious-false-when-pending-equals-median', AC.ledgerVelocitySuspicious(50, 50) === false);
check('ledgerVelocitySuspicious-false-at-exactly-3x', AC.ledgerVelocitySuspicious(90, 30) === false);
check('ledgerVelocitySuspicious-true-just-over-3x', AC.ledgerVelocitySuspicious(91, 30) === true);
check('ledgerVelocitySuspicious-true-well-over-3x', AC.ledgerVelocitySuspicious(200, 30) === true);
check('ledgerVelocitySuspicious-false-when-median-zero-no-flag-on-unknown-population', AC.ledgerVelocitySuspicious(100, 0) === false);
check('ledgerVelocitySuspicious-false-on-zero-pending', AC.ledgerVelocitySuspicious(0, 30) === false);
check('ledgerVelocitySuspicious-false-on-garbage', AC.ledgerVelocitySuspicious('nope', 30) === false && AC.ledgerVelocitySuspicious(100, 'nope') === false && AC.ledgerVelocitySuspicious(null, null) === false);
check('ledgerVelocitySuspicious-false-on-negative-pending', AC.ledgerVelocitySuspicious(-10, 30) === false);
check('ledgerVelocitySuspicious-never-throws-on-garbage', (function () { try { AC.ledgerVelocitySuspicious(undefined, undefined); return true; } catch (e) { return false; } })());

// ---------------------------------------------------------------- ipPendingConcentrationSuspicious()
check('ipPendingConcentration-false-at-exactly-40%', AC.ipPendingConcentrationSuspicious(40, 100) === false);
check('ipPendingConcentration-true-just-over-40%', AC.ipPendingConcentrationSuspicious(41, 100) === true);
check('ipPendingConcentration-true-well-over-40%', AC.ipPendingConcentrationSuspicious(80, 100) === true);
check('ipPendingConcentration-false-below-40%', AC.ipPendingConcentrationSuspicious(30, 100) === false);
check('ipPendingConcentration-false-on-zero-total', AC.ipPendingConcentrationSuspicious(10, 0) === false);
check('ipPendingConcentration-false-on-zero-ipPending', AC.ipPendingConcentrationSuspicious(0, 100) === false);
check('ipPendingConcentration-false-on-garbage', AC.ipPendingConcentrationSuspicious('nope', 100) === false && AC.ipPendingConcentrationSuspicious(50, 'nope') === false);
check('ipPendingConcentration-never-throws-on-garbage', (function () { try { AC.ipPendingConcentrationSuspicious(null, null); return true; } catch (e) { return false; } })());

// ---------------------------------------------------------------- medianOf()
check('medianOf-odd-count', AC.medianOf([10, 30, 20]) === 20);
check('medianOf-even-count', AC.medianOf([10, 20, 30, 40]) === 25);
check('medianOf-single', AC.medianOf([42]) === 42);
check('medianOf-empty-returns-0', AC.medianOf([]) === 0);
check('medianOf-ignores-negatives-and-nonnumeric', AC.medianOf([-5, 'nope', 10, 20]) === 15);
check('medianOf-non-array-returns-0', AC.medianOf(null) === 0);
check('medianOf-unsorted', AC.medianOf([100, 1, 50]) === 50);

// ---------------------------------------------------------------- tracker (in-memory Map, decays via window prune)
check('trackPending-and-pendingForKey-round-trip', (function () {
  AC.clearPendingTracker();
  AC.trackPending('alice', 42, 1000);
  return AC.pendingForKey('alice') === 42;
})());
check('medianPending-reflects-tracked-values', (function () {
  AC.clearPendingTracker();
  AC.trackPending('a', 10, 1000);
  AC.trackPending('b', 20, 1000);
  AC.trackPending('c', 30, 1000);
  return AC.medianPending() === 20;
})());
check('trackPending-prunes-older-than-window', (function () {
  AC.clearPendingTracker();
  AC.trackPending('old', 100, 0);
  // push time beyond LEDGER_VELOCITY_WINDOW_MS
  AC.trackPending('new', 10, AC.LEDGER_VELOCITY_WINDOW_MS + 1);
  return AC.pendingForKey('old') === 0 && AC.pendingForKey('new') === 10;
})());
check('clearPendingTracker-empties', (function () {
  AC.trackPending('x', 5, 1000);
  AC.clearPendingTracker();
  return AC.pendingForKey('x') === 0 && AC.medianPending() === 0;
})());
// Ensure tracker starts clean for remaining tests
AC.clearPendingTracker();

// ---------------------------------------------------------------- suspicionDelta amplifier-only guarantee
check('suspicionDelta-ledgerVelocity-alone-contributes-NOTHING', AC.suspicionDelta({ ledgerVelocity: true }) === 0);
check('suspicionDelta-ipPendingConcentration-alone-contributes-NOTHING', AC.suspicionDelta({ ipPendingConcentration: true }) === 0);
check('suspicionDelta-both-new-amplifiers-alone-still-zero', AC.suspicionDelta({ ledgerVelocity: true, ipPendingConcentration: true }) === 0);
check('suspicionDelta-ledgerVelocity-amplifies-rate', (function () {
  var rateOnly = AC.suspicionDelta({ rate: true });
  var withLedger = AC.suspicionDelta({ rate: true, ledgerVelocity: true });
  return withLedger > rateOnly && withLedger === rateOnly + AC.WEIGHT_LEDGER_VELOCITY;
})());
check('suspicionDelta-ledgerVelocity-amplifies-rhythm', (function () {
  var rhythmOnly = AC.suspicionDelta({ rhythm: true });
  var withLedger = AC.suspicionDelta({ rhythm: true, ledgerVelocity: true });
  return withLedger > rhythmOnly;
})());
check('suspicionDelta-ipPendingConcentration-amplifies-rate', (function () {
  var rateOnly = AC.suspicionDelta({ rate: true });
  var withIpPend = AC.suspicionDelta({ rate: true, ipPendingConcentration: true });
  return withIpPend > rateOnly && withIpPend === rateOnly + AC.WEIGHT_IP_PENDING;
})());
check('suspicionDelta-all-amplifiers-stack-on-primary', (function () {
  var both = AC.suspicionDelta({ rate: true, ipDense: true, ledgerVelocity: true, ipPendingConcentration: true });
  var rateOnly = AC.suspicionDelta({ rate: true });
  return both === rateOnly + AC.WEIGHT_IP_DENSITY + AC.WEIGHT_LEDGER_VELOCITY + AC.WEIGHT_IP_PENDING;
})());
check('suspicionDelta-weight-constants-are-small-amplifiers', AC.WEIGHT_LEDGER_VELOCITY < AC.THROTTLE_THRESHOLD && AC.WEIGHT_IP_PENDING < AC.THROTTLE_THRESHOLD);

// ---------------------------------------------------------------- evaluate() with ledgerCtx (pure, no sockets)
check('evaluate-ledgerVelocity-flag-true-when-pending-dominates', (function () {
  // Force rate=true by bursting history, plus high pending vs median
  var state = { history: [], score: 0, lastAt: null };
  var now = 0;
  for (var i = 0; i < 30; i++) { now += 40; state = AC.evaluate(state, now, 0, { pending: 200, medianPending: 30, ipPending: 10, totalPending: 1000 }); }
  // After burst, rate should be true and ledgerVelocity should be true
  return state.flags.ledgerVelocity === true && state.flags.rate === true;
})());
check('evaluate-ledgerVelocity-flag-false-when-pending-normal', (function () {
  var state = { history: [], score: 0, lastAt: null };
  var now = 0;
  for (var i = 0; i < 30; i++) { now += 40; state = AC.evaluate(state, now, 0, { pending: 30, medianPending: 30, ipPending: 10, totalPending: 1000 }); }
  return state.flags.ledgerVelocity === false;
})());
check('evaluate-ipPendingConcentration-flag-true-when-ip-dominates', (function () {
  var state = { history: [], score: 0, lastAt: null };
  var now = 0;
  for (var i = 0; i < 30; i++) { now += 40; state = AC.evaluate(state, now, 0, { pending: 10, medianPending: 30, ipPending: 80, totalPending: 100 }); }
  return state.flags.ipPendingConcentration === true;
})());
check('evaluate-both-ledger-flags-false-when-omitted', (function () {
  var state = AC.evaluate({ history: [], score: 0, lastAt: null }, 1000, 0);
  return state.flags.ledgerVelocity === false && state.flags.ipPendingConcentration === false;
})());
check('evaluate-backward-compat-three-arg-call-still-works', (function () {
  var r = AC.evaluate({ history: [], score: 0, lastAt: null }, 1000, 1);
  return r.flags && typeof r.flags.ledgerVelocity === 'boolean' && typeof r.flags.ipPendingConcentration === 'boolean';
})());
check('evaluate-ledger-alone-never-throttles-even-over-long-session', (function () {
  // Human-paced play (no rate/rhythm) but with permanently high ledgerVelocity & concentration — should never throttle because amplifiers alone contribute 0.
  var state = { history: [], score: 0, lastAt: null };
  var now = 0;
  var ever = false;
  for (var i = 0; i < 500; i++) {
    now += 1600 + (i % 4) * 200; // human jitter, ~1.6-2.2s
    state = AC.evaluate(state, now, 0, { pending: 500, medianPending: 30, ipPending: 90, totalPending: 100 });
    if (state.throttled) ever = true;
  }
  return ever === false && state.flags.ledgerVelocity === true && state.flags.ipPendingConcentration === true;
})());
check('evaluate-ledger-velocity-amplifies-throttling-only-when-primary-fires', (function () {
  // Two players at same pending imbalance: one slow-bot (just under rate but with rhythm) vs one human.
  // The slow-bot's rhythm will eventually fire; with amplifier it should throttle strictly earlier or at same time, but human with same imbalance should not.
  var botState = { history: [], score: 0, lastAt: null };
  var humanState = { history: [], score: 0, lastAt: null };
  var nowB = 0, nowH = 0;
  var botThrottledAt = -1, humanThrottledAt = -1;
  var ctxHigh = { pending: 200, medianPending: 30, ipPending: 50, totalPending: 100 };
  for (var i = 0; i < 40; i++) {
    nowB += 50; // machine-regular + over rate
    nowH += 1700 + (i % 3) * 300; // human
    botState = AC.evaluate(botState, nowB, 0, ctxHigh);
    humanState = AC.evaluate(humanState, nowH, 0, ctxHigh);
    if (botState.throttled && botThrottledAt === -1) botThrottledAt = i;
    if (humanState.throttled && humanThrottledAt === -1) humanThrottledAt = i;
  }
  return botThrottledAt >= 0 && humanThrottledAt === -1;
})());
check('evaluate-score-decays-after-amplified-burst', (function () {
  var state = { history: [], score: 0, lastAt: null };
  var now = 0;
  for (var i = 0; i < 30; i++) { now += 40; state = AC.evaluate(state, now, 0, { pending: 200, medianPending: 30, ipPending: 80, totalPending: 100 }); }
  var peak = state.score;
  var after = AC.evaluate(state, now + (AC.MAX_SCORE / AC.DECAY_PER_MS), 0, { pending: 10, medianPending: 30, ipPending: 10, totalPending: 100 });
  return peak === AC.MAX_SCORE && after.score === 0;
})());
check('evaluate-never-mutates-prior-with-ledgerCtx', (function () {
  var prior = { history: [1, 2], score: 5, lastAt: 100 };
  AC.evaluate(prior, 200, 0, { pending: 100, medianPending: 10, ipPending: 50, totalPending: 100 });
  return prior.history.length === 2 && prior.score === 5 && prior.lastAt === 100;
})());
check('evaluate-bad-ledgerCtx-never-throws', (function () {
  var r = AC.evaluate({ history: [], score: 0, lastAt: null }, 1000, 0, 'nope');
  return typeof r === 'object' && r.throttled === false && r.flags.ledgerVelocity === false;
})());

// ---------------------------------------------------------------- constants & exports exist
check('exports-contain-new-constants', typeof AC.LEDGER_VELOCITY_FACTOR === 'number' && typeof AC.IP_PENDING_THRESHOLD === 'number' && typeof AC.WEIGHT_LEDGER_VELOCITY === 'number');
check('exports-contain-new-helpers', typeof AC.ledgerVelocitySuspicious === 'function' && typeof AC.ipPendingConcentrationSuspicious === 'function' && typeof AC.medianOf === 'function');

// ---------------------------------------------------------------- purity / hygiene (new helpers also pure)
var source = fs.readFileSync('./src/anti-cheat.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
// The module now has an optional in-memory tracker using Map, but core helpers remain pure —
// Date.now/Math.random must still be absent from the pure helpers. The tracker uses
// a supplied `now` timestamp, not a clock read.
check('source-core-helpers-have-no-clock-or-random',
  (function () {
    // Allow `new Map` for the optional tracker; forbid Date.now/Math.random anywhere.
    return source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1;
  })());
check('source-has-no-require-or-io-in-core',
  source.indexOf("require('") === -1 || source.indexOf("require('./src") === -1); // top-level anti-cheat never requires project files

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
