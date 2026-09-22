/* test-mining-streak.js — assertions for src/mining-streak.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const MS = require('./src/mining-streak.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

const MID_GAP = 5000; // comfortably inside MIN_GAP_MS..MAX_GAP_MS

// ---------------------------------------------------------------- evaluate() - fresh player
check('evaluate-fresh-player-null-prior-streak-1', (function () {
  const r = MS.evaluate(null, 1000);
  return r.streak === 1;
})());
check('evaluate-fresh-player-null-prior-multiplier-is-one-step-bonus', (function () {
  const r = MS.evaluate(null, 1000);
  return Math.abs(r.multiplier - (1 + MS.STEP_BONUS)) < 1e-9 && r.multiplier > 1.0;
})());
check('evaluate-fresh-player-zero-streak-null-lastAt', (function () {
  const r = MS.evaluate({ streak: 0, lastAt: null }, 1000);
  return r.streak === 1 && r.lastAt === 1000;
})());

// ---------------------------------------------------------------- evaluate() - sustained run
check('evaluate-sustained-run-streak-climbs-monotonically-and-caps', (function () {
  let state = null;
  let t = 0;
  const streaks = [];
  const mults = [];
  for (let i = 0; i < 60; i++) {
    t += MID_GAP;
    state = MS.evaluate(state, t);
    streaks.push(state.streak);
    mults.push(state.multiplier);
  }
  // streak should be 1..60 in order
  for (let i = 0; i < 60; i++) if (streaks[i] !== i + 1) return false;
  // multiplier rises monotonically (non-decreasing) throughout
  for (let i = 1; i < mults.length; i++) if (mults[i] < mults[i - 1]) return false;
  // caps at 1 + MAX_BONUS and stays flat once reached
  const capIndex = mults.findIndex(m => Math.abs(m - (1 + MS.MAX_BONUS)) < 1e-9);
  if (capIndex === -1) return false;
  for (let i = capIndex; i < mults.length; i++) {
    if (Math.abs(mults[i] - (1 + MS.MAX_BONUS)) > 1e-9) return false;
  }
  return true;
})());

// ---------------------------------------------------------------- evaluate() - too fast
check('evaluate-gap-just-below-MIN_GAP_MS-does-not-increment', (function () {
  const first = MS.evaluate(null, 0);               // streak 1
  const second = MS.evaluate(first, MS.MIN_GAP_MS - 1);
  return second.streak === first.streak;
})());
check('evaluate-gap-just-below-MIN_GAP_MS-does-not-decrement-either', (function () {
  let state = null, t = 0;
  for (let i = 0; i < 3; i++) { t += MID_GAP; state = MS.evaluate(state, t); }
  const before = state.streak;
  t += (MS.MIN_GAP_MS - 1);
  const after = MS.evaluate(state, t);
  return after.streak === before;
})());

// ---------------------------------------------------------------- evaluate() - too slow
check('evaluate-gap-just-above-MAX_GAP_MS-resets-to-1-not-0', (function () {
  let state = null, t = 0;
  for (let i = 0; i < 5; i++) { t += MID_GAP; state = MS.evaluate(state, t); }
  t += (MS.MAX_GAP_MS + 1);
  const after = MS.evaluate(state, t);
  return after.streak === 1;
})());

// ---------------------------------------------------------------- boundary inclusivity
check('evaluate-gap-exactly-at-MIN_GAP_MS-counts-as-sweet-spot-increments', (function () {
  const first = MS.evaluate(null, 0);
  const second = MS.evaluate(first, MS.MIN_GAP_MS);
  return second.streak === first.streak + 1;
})());
check('evaluate-gap-exactly-at-MAX_GAP_MS-counts-as-sweet-spot-increments', (function () {
  const first = MS.evaluate(null, 0);
  const second = MS.evaluate(first, MS.MAX_GAP_MS);
  return second.streak === first.streak + 1;
})());
check('evaluate-gap-one-ms-inside-both-boundaries-increments', (function () {
  const first = MS.evaluate(null, 0);
  const second = MS.evaluate(first, MS.MIN_GAP_MS + 1);
  return second.streak === first.streak + 1;
})());

// ---------------------------------------------------------------- multiplierForStreak()
check('multiplierForStreak-zero-is-exactly-base', MS.multiplierForStreak(0) === 1.0);
check('multiplierForStreak-negative-is-exactly-base', MS.multiplierForStreak(-5) === 1.0);
check('multiplierForStreak-malformed-is-exactly-base', (function () {
  return MS.multiplierForStreak('lots') === 1.0 && MS.multiplierForStreak(null) === 1.0 &&
    MS.multiplierForStreak(undefined) === 1.0 && MS.multiplierForStreak(NaN) === 1.0;
})());
check('multiplierForStreak-one-step', (function () {
  return Math.abs(MS.multiplierForStreak(1) - (1 + MS.STEP_BONUS)) < 1e-9;
})());
check('multiplierForStreak-exceeds-cap-is-exactly-1-plus-MAX_BONUS', (function () {
  const streakAtCap = Math.ceil(MS.MAX_BONUS / MS.STEP_BONUS);
  const wayOverStreak = streakAtCap + 1000;
  return MS.multiplierForStreak(wayOverStreak) === 1 + MS.MAX_BONUS &&
    MS.multiplierForStreak(streakAtCap) === 1 + MS.MAX_BONUS;
})());
check('multiplierForStreak-never-exceeds-cap-across-sweep', (function () {
  for (let s = 0; s <= 500; s++) {
    if (MS.multiplierForStreak(s) > 1 + MS.MAX_BONUS + 1e-9) return false;
  }
  return true;
})());

// ---------------------------------------------------------------- boostedAmount()
check('boostedAmount-applies-multiplier-and-floors', (function () {
  return MS.boostedAmount(100, 1.25) === 125 && MS.boostedAmount(99, 1.25) === 123; // 99*1.25=123.75
})());
check('boostedAmount-base-multiplier-no-change', MS.boostedAmount(50, 1.0) === 50);
check('boostedAmount-never-reduces-below-original', (function () {
  return MS.boostedAmount(50, 0.5) === 50 && MS.boostedAmount(50, 0) === 50 &&
    MS.boostedAmount(50, -3) === 50;
})());
check('boostedAmount-malformed-multiplier-treated-as-one', (function () {
  return MS.boostedAmount(50, 'x') === 50 && MS.boostedAmount(50, null) === 50 &&
    MS.boostedAmount(50, NaN) === 50 && MS.boostedAmount(50, undefined) === 50;
})());
check('boostedAmount-malformed-amount-treated-as-zero', (function () {
  return MS.boostedAmount('x', 1.5) === 0 && MS.boostedAmount(null, 1.5) === 0 &&
    MS.boostedAmount(-5, 1.5) === 0 && MS.boostedAmount(1.5, 1.5) === 0;
})());
check('boostedAmount-never-throws-on-garbage', (function () {
  try {
    MS.boostedAmount(undefined, undefined);
    MS.boostedAmount({}, []);
    MS.boostedAmount(NaN, Infinity);
    return true;
  } catch (e) { return false; }
})());

// ---------------------------------------------------------------- boostedReward()
check('boostedReward-boosts-both-fields', (function () {
  const r = MS.boostedReward({ gold: 100, token: 40 }, 1.5);
  return r.gold === 150 && r.token === 60;
})());
check('boostedReward-never-reduces-below-original', (function () {
  const r = MS.boostedReward({ gold: 100, token: 40 }, 0.1);
  return r.gold === 100 && r.token === 40;
})());
check('boostedReward-malformed-fields-treated-as-zero', (function () {
  const r = MS.boostedReward({ gold: 'x', token: undefined }, 1.5);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-malformed-reward-never-throws', (function () {
  try {
    const r1 = MS.boostedReward(null, 1.5);
    const r2 = MS.boostedReward('nope', 1.5);
    const r3 = MS.boostedReward(undefined, 1.5);
    return r1.gold === 0 && r1.token === 0 && r2.gold === 0 && r3.gold === 0;
  } catch (e) { return false; }
})());

// ---------------------------------------------------------------- evaluate() - never throws on garbage
check('evaluate-never-throws-null-prior', (function () {
  try { MS.evaluate(null, 1000); return true; } catch (e) { return false; }
})());
check('evaluate-never-throws-string-prior', (function () {
  try { const r = MS.evaluate('garbage', 1000); return r.streak === 1; } catch (e) { return false; }
})());
check('evaluate-never-throws-number-prior', (function () {
  try { const r = MS.evaluate(42, 1000); return r.streak === 1; } catch (e) { return false; }
})());
check('evaluate-never-throws-undefined-now', (function () {
  try { const r = MS.evaluate({ streak: 3, lastAt: 100 }, undefined); return r.streak === 3; } catch (e) { return false; }
})());
check('evaluate-never-throws-NaN-now', (function () {
  try { const r = MS.evaluate({ streak: 3, lastAt: 100 }, NaN); return r.streak === 3; } catch (e) { return false; }
})());
check('evaluate-never-throws-string-now', (function () {
  try { const r = MS.evaluate({ streak: 3, lastAt: 100 }, 'not a number'); return r.streak === 3; } catch (e) { return false; }
})());
check('evaluate-never-throws-malformed-streak-field', (function () {
  try { const r = MS.evaluate({ streak: 'x', lastAt: 100 }, 5000); return isFinite(r.streak); } catch (e) { return false; }
})());
check('evaluate-never-throws-malformed-lastAt-field', (function () {
  try { const r = MS.evaluate({ streak: 3, lastAt: 'x' }, 5000); return r.streak === 1; } catch (e) { return false; }
})());
check('evaluate-clock-going-backwards-never-throws-or-breaks-forward', (function () {
  try {
    const first = MS.evaluate(null, 5000);
    const second = MS.evaluate(first, 1000); // now < lastAt
    return second.streak === first.streak;   // treated conservatively, no crash
  } catch (e) { return false; }
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/mining-streak.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-of-project-file', source.indexOf('require(') === -1);
check('source-has-no-io', source.indexOf('XMLHttpRequest') === -1 && source.indexOf('process.') === -1);
check('exports-constants-are-numbers', (function () {
  return typeof MS.MIN_GAP_MS === 'number' && typeof MS.MAX_GAP_MS === 'number' &&
    typeof MS.STEP_BONUS === 'number' && typeof MS.MAX_BONUS === 'number';
})());

// Sanity note (comment-only, not a runtime check — this module never imports anti-cheat.js,
// so it cannot literally assert against AntiCheat's constants): a mid-sweet-spot pace of one
// action every 3-8 seconds is ~0.125-0.33 actions/sec, nowhere close to anti-cheat's RATE
// ceiling of 2.5 actions/sec sustained (25 per 10s window), and natural human timing jitter
// at that cadence sits nowhere near anti-cheat's RHYTHM coefficient-of-variation floor of
// 0.08 (perfectly uniform bot-like timing). Nothing in this module rewards going faster than
// MIN_GAP_MS = 900ms, which is itself far below the ~400ms/action anti-cheat RATE threshold.
check('sanity-mid-sweet-spot-pace-is-far-from-anti-cheat-rate-ceiling', (function () {
  const ANTI_CHEAT_RATE_MAX_PER_WINDOW = 25;      // from src/anti-cheat.js
  const ANTI_CHEAT_WINDOW_MS = 10000;             // from src/anti-cheat.js
  const antiCheatMinGapForRateFloor = ANTI_CHEAT_WINDOW_MS / ANTI_CHEAT_RATE_MAX_PER_WINDOW; // 400ms
  const midSweetSpotGapMs = 5000;
  const actionsPerWindowAtMidPace = ANTI_CHEAT_WINDOW_MS / midSweetSpotGapMs;
  // A mid-pace mine (one every 5s) is nowhere near the RATE ceiling...
  return actionsPerWindowAtMidPace < ANTI_CHEAT_RATE_MAX_PER_WINDOW &&
    // ...and this module's own MIN_GAP_MS floor is comfortably above the gap that would
    // even theoretically saturate anti-cheat's RATE window (400ms), so nothing here can
    // push a player toward that edge.
    MS.MIN_GAP_MS >= antiCheatMinGapForRateFloor;
})());

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
