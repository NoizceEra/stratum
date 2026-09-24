/* test-builder-bonus.js — assertions for src/builder-bonus.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const BB = require('./src/builder-bonus.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- TIERS table itself
check('TIERS-is-frozen', Object.isFrozen(BB.TIERS));
check('TIERS-entries-are-frozen', BB.TIERS.every((t) => Object.isFrozen(t)));
check('TIERS-sorted-ascending-by-minStructures', (function () {
  for (let i = 1; i < BB.TIERS.length; i++) {
    if (BB.TIERS[i].minStructures <= BB.TIERS[i - 1].minStructures) return false;
  }
  return true;
})());
check('TIERS-every-multiplier-gte-1', BB.TIERS.every((t) => t.multiplier >= 1.0));
check('TIERS-has-five-tiers', BB.TIERS.length === 5);
check('BASE_MULTIPLIER-is-1', BB.BASE_MULTIPLIER === 1.0);
check('TIERS-ceiling-matches-holder-bonus', BB.TIERS[BB.TIERS.length - 1].multiplier === 2.00);

// ---------------------------------------------------------------- tierFor() boundaries
check('tierFor-0-is-settler', BB.tierFor(0).name === 'Settler');
check('tierFor-1-is-settler', BB.tierFor(1).name === 'Settler');
check('tierFor-2-is-builder', BB.tierFor(2).name === 'Builder');
check('tierFor-3-is-builder', BB.tierFor(3).name === 'Builder');
check('tierFor-4-is-builder', BB.tierFor(4).name === 'Builder');
check('tierFor-5-is-architect', BB.tierFor(5).name === 'Architect');
check('tierFor-9-is-architect', BB.tierFor(9).name === 'Architect');
check('tierFor-10-is-engineer', BB.tierFor(10).name === 'Engineer');
check('tierFor-19-is-engineer', BB.tierFor(19).name === 'Engineer');
check('tierFor-20-is-overseer', BB.tierFor(20).name === 'Overseer');
check('tierFor-21-is-overseer', BB.tierFor(21).name === 'Overseer');
check('tierFor-large-count-is-overseer', (function () {
  const t = BB.tierFor(5000);
  return t.name === 'Overseer' && t.multiplier === 2.00;
})());
check('tierFor-returns-actual-frozen-reference', BB.tierFor(20) === BB.TIERS[4]);

// tier multipliers correct
check('tierFor-2-multiplier-1.10', BB.tierFor(2).multiplier === 1.10);
check('tierFor-5-multiplier-1.25', BB.tierFor(5).multiplier === 1.25);
check('tierFor-10-multiplier-1.50', BB.tierFor(10).multiplier === 1.50);

// ---------------------------------------------------------------- tierFor() malformed input
check('tierFor-negative-is-settler', BB.tierFor(-5).name === 'Settler');
check('tierFor-NaN-is-settler', BB.tierFor(NaN).name === 'Settler');
check('tierFor-Infinity-is-settler', BB.tierFor(Infinity).name === 'Settler');
check('tierFor-fractional-is-settler', BB.tierFor(2.5).name === 'Settler');
check('tierFor-string-is-settler', BB.tierFor('lots').name === 'Settler');
check('tierFor-null-is-settler', BB.tierFor(null).name === 'Settler');
check('tierFor-undefined-is-settler', BB.tierFor(undefined).name === 'Settler');
check('tierFor-object-is-settler', BB.tierFor({}).name === 'Settler');
check('tierFor-array-is-settler', BB.tierFor([]).name === 'Settler');
check('tierFor-never-throws-on-garbage', (function () {
  try {
    BB.tierFor(undefined); BB.tierFor(null); BB.tierFor('x'); BB.tierFor({}); BB.tierFor(NaN); BB.tierFor(Infinity); BB.tierFor(-Infinity);
    return true;
  } catch (e) { return false; }
})());
check('tierFor-never-returns-undefined', (function () {
  const vals = [0, -1, NaN, Infinity, -Infinity, 'x', null, undefined, {}, [], 5000];
  return vals.every((v) => BB.tierFor(v) !== undefined && BB.tierFor(v) !== null);
})());

// ---------------------------------------------------------------- multiplierFor()
check('multiplierFor-0-is-1.0', BB.multiplierFor(0) === 1.0);
check('multiplierFor-2-is-1.10', BB.multiplierFor(2) === 1.10);
check('multiplierFor-5-is-1.25', BB.multiplierFor(5) === 1.25);
check('multiplierFor-10-is-1.50', BB.multiplierFor(10) === 1.50);
check('multiplierFor-20-is-2.00', BB.multiplierFor(20) === 2.00);
check('multiplierFor-malformed-is-1.0', BB.multiplierFor('bad') === 1.0);
check('multiplierFor-returns-plain-number', typeof BB.multiplierFor(5) === 'number');

// ---------------------------------------------------------------- boostedAmount()
check('boostedAmount-no-op-at-1.0', BB.boostedAmount(100, 1.0) === 100);
check('boostedAmount-applies-multiplier', BB.boostedAmount(100, 1.25) === 125);
check('boostedAmount-floors-non-integer-product', BB.boostedAmount(10, 1.25) === 12); // 12.5 -> 12
check('boostedAmount-floors-another-case', BB.boostedAmount(3, 1.10) === 3); // 3.3 -> 3
check('boostedAmount-overseer-doubles', BB.boostedAmount(50, 2.00) === 100);
check('boostedAmount-never-below-amount-with-valid-multiplier', (function () {
  for (let amt = 0; amt <= 20; amt++) {
    for (const t of BB.TIERS) {
      if (BB.boostedAmount(amt, t.multiplier) < amt) return false;
    }
  }
  return true;
})());
check('boostedAmount-clamps-sub-1.0-multiplier-to-1.0', BB.boostedAmount(100, 0.5) === 100);
check('boostedAmount-clamps-negative-multiplier-to-1.0', BB.boostedAmount(100, -3) === 100);
check('boostedAmount-clamps-zero-multiplier-to-1.0', BB.boostedAmount(100, 0) === 100);
check('boostedAmount-NaN-multiplier-treated-as-1.0', BB.boostedAmount(100, NaN) === 100);
check('boostedAmount-Infinity-multiplier-treated-as-1.0', BB.boostedAmount(100, Infinity) === 100);
check('boostedAmount-non-number-multiplier-treated-as-1.0', BB.boostedAmount(100, 'x') === 100);
check('boostedAmount-null-multiplier-treated-as-1.0', BB.boostedAmount(100, null) === 100);
check('boostedAmount-undefined-multiplier-treated-as-1.0', BB.boostedAmount(100, undefined) === 100);
check('boostedAmount-zero-amount-is-zero', BB.boostedAmount(0, 2.0) === 0);
check('boostedAmount-negative-amount-is-zero', BB.boostedAmount(-5, 2.0) === 0);
check('boostedAmount-fractional-amount-is-zero', BB.boostedAmount(1.5, 2.0) === 0);
check('boostedAmount-non-number-amount-is-zero', BB.boostedAmount('x', 2.0) === 0);
check('boostedAmount-null-amount-is-zero', BB.boostedAmount(null, 2.0) === 0);
check('boostedAmount-undefined-amount-is-zero', BB.boostedAmount(undefined, 2.0) === 0);
check('boostedAmount-NaN-amount-is-zero', BB.boostedAmount(NaN, 2.0) === 0);
check('boostedAmount-never-throws-on-garbage', (function () {
  try {
    BB.boostedAmount(undefined, undefined);
    BB.boostedAmount(null, null);
    BB.boostedAmount('x', 'y');
    BB.boostedAmount({}, []);
    BB.boostedAmount(NaN, Infinity);
    return true;
  } catch (e) { return false; }
})());

// ---------------------------------------------------------------- boostedReward()
check('boostedReward-boosts-both-legs', (function () {
  const r = BB.boostedReward({ gold: 10, token: 20 }, 1.5);
  return r.gold === 15 && r.token === 30;
})());
check('boostedReward-preserves-shape', (function () {
  const r = BB.boostedReward({ gold: 10, token: 20 }, 1.25);
  const keys = Object.keys(r).sort();
  return keys.length === 2 && keys[0] === 'gold' && keys[1] === 'token';
})());
check('boostedReward-independent-legs', (function () {
  const r = BB.boostedReward({ gold: 3, token: 7 }, 1.10); // gold 3.3->3, token 7.7->7
  return r.gold === 3 && r.token === 7;
})());
check('boostedReward-missing-gold-treated-as-0', (function () {
  const r = BB.boostedReward({ token: 20 }, 2.0);
  return r.gold === 0 && r.token === 40;
})());
check('boostedReward-missing-token-treated-as-0', (function () {
  const r = BB.boostedReward({ gold: 20 }, 2.0);
  return r.gold === 40 && r.token === 0;
})());
check('boostedReward-empty-object', (function () {
  const r = BB.boostedReward({}, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-null-reward-never-throws', (function () {
  const r = BB.boostedReward(null, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-undefined-reward-never-throws', (function () {
  const r = BB.boostedReward(undefined, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-returns-fresh-object-not-input', (function () {
  const input = { gold: 10, token: 20 };
  const r = BB.boostedReward(input, 1.5);
  return r !== input;
})());
check('boostedReward-does-not-mutate-input', (function () {
  const input = { gold: 10, token: 20 };
  BB.boostedReward(input, 1.5);
  return input.gold === 10 && input.token === 20;
})());
check('boostedReward-1.0-multiplier-no-op', (function () {
  const r = BB.boostedReward({ gold: 5, token: 9 }, 1.0);
  return r.gold === 5 && r.token === 9;
})());
check('boostedReward-malformed-multiplier-defaults-to-no-boost', (function () {
  const r = BB.boostedReward({ gold: 5, token: 9 }, 'bad');
  return r.gold === 5 && r.token === 9;
})());

// end-to-end: multiplierFor feeding boostedReward for every tier boundary
check('end-to-end-tier-boundaries-boost-correctly', (function () {
  const cases = [
    [0, 1.0], [1, 1.0], [2, 1.10], [4, 1.10],
    [5, 1.25], [9, 1.25], [10, 1.50], [19, 1.50],
    [20, 2.00], [5000, 2.00]
  ];
  return cases.every(([count, expectedMult]) => {
    const m = BB.multiplierFor(count);
    if (m !== expectedMult) return false;
    const r = BB.boostedReward({ gold: 100, token: 100 }, m);
    return r.gold === Math.floor(100 * expectedMult) && r.token === Math.floor(100 * expectedMult);
  });
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/builder-bonus.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-of-project-file',
  source.indexOf("require('./") === -1 && source.indexOf('require("./') === -1);
check('source-has-no-io',
  source.indexOf('XMLHttpRequest') === -1 && source.indexOf('process.') === -1 &&
  source.indexOf('fetch(') === -1);
check('exports-are-well-typed',
  typeof BB.BASE_MULTIPLIER === 'number' && Array.isArray(BB.TIERS) &&
  typeof BB.tierFor === 'function' && typeof BB.multiplierFor === 'function' &&
  typeof BB.boostedAmount === 'function' && typeof BB.boostedReward === 'function');

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
