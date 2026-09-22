/* test-colony-milestone.js — assertions for src/colony-milestone.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const CM = require('./src/colony-milestone.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- milestoneFor() boundaries
check('milestoneFor-999-is-Outpost', CM.milestoneFor(999).name === 'Outpost');
check('milestoneFor-1000-is-Settlement', CM.milestoneFor(1000).name === 'Settlement');
check('milestoneFor-9999-is-Settlement', CM.milestoneFor(9999).name === 'Settlement');
check('milestoneFor-10000-is-Colony', CM.milestoneFor(10000).name === 'Colony');
check('milestoneFor-99999-is-Colony', CM.milestoneFor(99999).name === 'Colony');
check('milestoneFor-100000-is-Province', CM.milestoneFor(100000).name === 'Province');
check('milestoneFor-999999-is-Province', CM.milestoneFor(999999).name === 'Province');
check('milestoneFor-1000000-is-Dominion', CM.milestoneFor(1000000).name === 'Dominion');
check('milestoneFor-0-is-Outpost', CM.milestoneFor(0).name === 'Outpost');

// multiplier correctness at each boundary
check('multiplierFor-999-is-1.00', CM.multiplierFor(999) === 1.00);
check('multiplierFor-1000-is-1.02', CM.multiplierFor(1000) === 1.02);
check('multiplierFor-10000-is-1.05', CM.multiplierFor(10000) === 1.05);
check('multiplierFor-100000-is-1.10', CM.multiplierFor(100000) === 1.10);
check('multiplierFor-1000000-is-1.20', CM.multiplierFor(1000000) === 1.20);

// ---------------------------------------------------------------- malformed input -> base tier
check('milestoneFor-negative-is-Outpost', CM.milestoneFor(-5).name === 'Outpost');
check('milestoneFor-NaN-is-Outpost', CM.milestoneFor(NaN).name === 'Outpost');
check('milestoneFor-Infinity-is-Outpost', CM.milestoneFor(Infinity).name === 'Outpost');
check('milestoneFor-string-is-Outpost', CM.milestoneFor('lots').name === 'Outpost');
check('milestoneFor-null-is-Outpost', CM.milestoneFor(null).name === 'Outpost');
check('milestoneFor-undefined-is-Outpost', CM.milestoneFor(undefined).name === 'Outpost');
check('milestoneFor-never-throws-on-object', (function () {
  try { return CM.milestoneFor({}).name === 'Outpost'; } catch (e) { return false; }
})());
check('milestoneFor-never-returns-undefined', CM.milestoneFor('garbage') !== undefined);

// ---------------------------------------------------------------- far past the top tier
check('milestoneFor-50-million-is-Dominion', CM.milestoneFor(50000000).name === 'Dominion');
check('multiplierFor-50-million-is-1.20', CM.multiplierFor(50000000) === 1.20);

// ---------------------------------------------------------------- nextMilestone()
check('nextMilestone-0-is-Settlement-remaining-1000', (function () {
  const n = CM.nextMilestone(0);
  return n.name === 'Settlement' && n.minQuota === 1000 && n.remaining === 1000;
})());
check('nextMilestone-999-remaining-1', (function () {
  const n = CM.nextMilestone(999);
  return n.name === 'Settlement' && n.remaining === 1;
})());
check('nextMilestone-1000-is-Colony-remaining-9000', (function () {
  const n = CM.nextMilestone(1000);
  return n.name === 'Colony' && n.minQuota === 10000 && n.remaining === 9000;
})());
check('nextMilestone-9999-is-Colony-remaining-1', (function () {
  const n = CM.nextMilestone(9999);
  return n.name === 'Colony' && n.remaining === 1;
})());
check('nextMilestone-10000-is-Province-remaining-90000', (function () {
  const n = CM.nextMilestone(10000);
  return n.name === 'Province' && n.minQuota === 100000 && n.remaining === 90000;
})());
check('nextMilestone-100000-is-Dominion-remaining-900000', (function () {
  const n = CM.nextMilestone(100000);
  return n.name === 'Dominion' && n.minQuota === 1000000 && n.remaining === 900000;
})());
check('nextMilestone-999999-remaining-1', (function () {
  const n = CM.nextMilestone(999999);
  return n.name === 'Dominion' && n.remaining === 1;
})());
check('nextMilestone-at-1000000-is-null', CM.nextMilestone(1000000) === null);
check('nextMilestone-past-final-tier-is-null', CM.nextMilestone(5000000) === null);
check('nextMilestone-malformed-treated-as-zero', (function () {
  const n = CM.nextMilestone(NaN);
  return n.name === 'Settlement' && n.remaining === 1000;
})());
check('nextMilestone-negative-treated-as-zero', (function () {
  const n = CM.nextMilestone(-100);
  return n.name === 'Settlement' && n.remaining === 1000;
})());
check('nextMilestone-never-throws-on-garbage', (function () {
  try { CM.nextMilestone('x'); CM.nextMilestone(undefined); CM.nextMilestone({}); return true; }
  catch (e) { return false; }
})());

// ---------------------------------------------------------------- boostedAmount()
check('boostedAmount-no-op-at-1.0', CM.boostedAmount(100, 1.0) === 100);
check('boostedAmount-applies-multiplier', CM.boostedAmount(100, 1.02) === 102);
check('boostedAmount-floors', CM.boostedAmount(100, 1.05) === 105);
check('boostedAmount-floors-fractional', CM.boostedAmount(37, 1.05) === 38); // 37*1.05=38.85 -> 38
check('boostedAmount-never-below-original', CM.boostedAmount(100, 0.5) === 100);
check('boostedAmount-zero-amount-is-zero', CM.boostedAmount(0, 1.2) === 0);
check('boostedAmount-negative-amount-treated-as-zero', CM.boostedAmount(-10, 1.2) === 0);
check('boostedAmount-malformed-amount-never-throws', (function () {
  try { return CM.boostedAmount('x', 1.2) === 0; } catch (e) { return false; }
})());
check('boostedAmount-malformed-multiplier-treated-as-1.0', CM.boostedAmount(100, 'x') === 100);
check('boostedAmount-NaN-multiplier-treated-as-1.0', CM.boostedAmount(100, NaN) === 100);
check('boostedAmount-negative-multiplier-treated-as-1.0', CM.boostedAmount(100, -1) === 100);
check('boostedAmount-null-args-never-throw', (function () {
  try { return CM.boostedAmount(null, null) === 0; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- boostedReward()
check('boostedReward-applies-to-both-fields', (function () {
  const r = CM.boostedReward({ gold: 100, token: 200 }, 1.10);
  return r.gold === 110 && r.token === 220;
})());
check('boostedReward-no-op-at-1.0', (function () {
  const r = CM.boostedReward({ gold: 50, token: 75 }, 1.0);
  return r.gold === 50 && r.token === 75;
})());
check('boostedReward-never-reduces', (function () {
  const r = CM.boostedReward({ gold: 50, token: 75 }, 0.1);
  return r.gold === 50 && r.token === 75;
})());
check('boostedReward-missing-fields-treated-as-zero', (function () {
  const r = CM.boostedReward({}, 1.2);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-null-reward-never-throws', (function () {
  try { const r = CM.boostedReward(null, 1.2); return r.gold === 0 && r.token === 0; }
  catch (e) { return false; }
})());
check('boostedReward-garbage-fields-never-throws', (function () {
  try { const r = CM.boostedReward({ gold: 'x', token: undefined }, 1.2); return r.gold === 0 && r.token === 0; }
  catch (e) { return false; }
})());

// ---------------------------------------------------------------- TIERS shape
check('TIERS-is-frozen', Object.isFrozen(CM.TIERS));
check('TIERS-entries-are-frozen', CM.TIERS.every(function (t) { return Object.isFrozen(t); }));
check('TIERS-sorted-ascending-by-minQuota', (function () {
  for (let i = 1; i < CM.TIERS.length; i++) {
    if (CM.TIERS[i].minQuota <= CM.TIERS[i - 1].minQuota) return false;
  }
  return true;
})());
check('TIERS-all-multipliers-at-least-1.0', CM.TIERS.every(function (t) { return t.multiplier >= 1.0; }));
check('TIERS-has-five-tiers', CM.TIERS.length === 5);
check('BASE_MULTIPLIER-is-1.0', CM.BASE_MULTIPLIER === 1.0);

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/colony-milestone.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-well-typed', typeof CM.BASE_MULTIPLIER === 'number' && Array.isArray(CM.TIERS));

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
