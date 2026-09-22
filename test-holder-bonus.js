/* test-holder-bonus.js — assertions for src/holder-bonus.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const HB = require('./src/holder-bonus.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- TIERS table itself
check('TIERS-is-frozen', Object.isFrozen(HB.TIERS));
check('TIERS-entries-are-frozen', HB.TIERS.every((t) => Object.isFrozen(t)));
check('TIERS-sorted-ascending-by-minBalance', (function () {
  for (let i = 1; i < HB.TIERS.length; i++) {
    if (HB.TIERS[i].minBalance <= HB.TIERS[i - 1].minBalance) return false;
  }
  return true;
})());
check('TIERS-every-multiplier-gte-1', HB.TIERS.every((t) => t.multiplier >= 1.0));
check('TIERS-has-five-tiers', HB.TIERS.length === 5);
check('BASE_MULTIPLIER-is-1', HB.BASE_MULTIPLIER === 1.0);

// ---------------------------------------------------------------- tierFor() boundaries
check('tierFor-0-is-colonist', HB.tierFor(0).name === 'Colonist');
check('tierFor-99-is-colonist', HB.tierFor(99).name === 'Colonist');
check('tierFor-100-is-backer', HB.tierFor(100).name === 'Backer');
check('tierFor-101-is-backer', HB.tierFor(101).name === 'Backer');
check('tierFor-999-is-backer', HB.tierFor(999).name === 'Backer');
check('tierFor-1000-is-investor', HB.tierFor(1000).name === 'Investor');
check('tierFor-1001-is-investor', HB.tierFor(1001).name === 'Investor');
check('tierFor-9999-is-investor', HB.tierFor(9999).name === 'Investor');
check('tierFor-10000-is-founder', HB.tierFor(10000).name === 'Founder');
check('tierFor-10001-is-founder', HB.tierFor(10001).name === 'Founder');
check('tierFor-99999-is-founder', HB.tierFor(99999).name === 'Founder');
check('tierFor-100000-is-silverlord', HB.tierFor(100000).name === 'Silverlord');
check('tierFor-100001-is-silverlord', HB.tierFor(100001).name === 'Silverlord');
check('tierFor-large-balance-is-silverlord', (function () {
  const t = HB.tierFor(50000000);
  return t.name === 'Silverlord' && t.multiplier === 2.00;
})());
check('tierFor-returns-actual-frozen-reference', HB.tierFor(100000) === HB.TIERS[4]);

// tier multipliers correct
check('tierFor-100-multiplier-1.10', HB.tierFor(100).multiplier === 1.10);
check('tierFor-1000-multiplier-1.25', HB.tierFor(1000).multiplier === 1.25);
check('tierFor-10000-multiplier-1.50', HB.tierFor(10000).multiplier === 1.50);

// ---------------------------------------------------------------- tierFor() malformed input
check('tierFor-negative-is-colonist', HB.tierFor(-5).name === 'Colonist');
check('tierFor-NaN-is-colonist', HB.tierFor(NaN).name === 'Colonist');
check('tierFor-Infinity-is-colonist', HB.tierFor(Infinity).multiplier === 2.00 ? false : HB.tierFor(Infinity).name === 'Colonist');
check('tierFor-string-is-colonist', HB.tierFor('lots').name === 'Colonist');
check('tierFor-null-is-colonist', HB.tierFor(null).name === 'Colonist');
check('tierFor-undefined-is-colonist', HB.tierFor(undefined).name === 'Colonist');
check('tierFor-object-is-colonist', HB.tierFor({}).name === 'Colonist');
check('tierFor-array-is-colonist', HB.tierFor([]).name === 'Colonist');
check('tierFor-never-throws-on-garbage', (function () {
  try {
    HB.tierFor(undefined); HB.tierFor(null); HB.tierFor('x'); HB.tierFor({}); HB.tierFor(NaN); HB.tierFor(Infinity); HB.tierFor(-Infinity);
    return true;
  } catch (e) { return false; }
})());
check('tierFor-never-returns-undefined', (function () {
  const vals = [0, -1, NaN, Infinity, -Infinity, 'x', null, undefined, {}, [], 50000000];
  return vals.every((v) => HB.tierFor(v) !== undefined && HB.tierFor(v) !== null);
})());

// ---------------------------------------------------------------- multiplierFor()
check('multiplierFor-0-is-1.0', HB.multiplierFor(0) === 1.0);
check('multiplierFor-100-is-1.10', HB.multiplierFor(100) === 1.10);
check('multiplierFor-1000-is-1.25', HB.multiplierFor(1000) === 1.25);
check('multiplierFor-10000-is-1.50', HB.multiplierFor(10000) === 1.50);
check('multiplierFor-100000-is-2.00', HB.multiplierFor(100000) === 2.00);
check('multiplierFor-malformed-is-1.0', HB.multiplierFor('bad') === 1.0);
check('multiplierFor-returns-plain-number', typeof HB.multiplierFor(1000) === 'number');

// ---------------------------------------------------------------- boostedAmount()
check('boostedAmount-no-op-at-1.0', HB.boostedAmount(100, 1.0) === 100);
check('boostedAmount-applies-multiplier', HB.boostedAmount(100, 1.25) === 125);
check('boostedAmount-floors-non-integer-product', HB.boostedAmount(10, 1.25) === 12); // 12.5 -> 12
check('boostedAmount-floors-another-case', HB.boostedAmount(3, 1.10) === 3); // 3.3 -> 3
check('boostedAmount-silverlord-doubles', HB.boostedAmount(50, 2.00) === 100);
check('boostedAmount-never-below-amount-with-valid-multiplier', (function () {
  for (let amt = 0; amt <= 20; amt++) {
    for (const t of HB.TIERS) {
      if (HB.boostedAmount(amt, t.multiplier) < amt) return false;
    }
  }
  return true;
})());
check('boostedAmount-clamps-sub-1.0-multiplier-to-1.0', HB.boostedAmount(100, 0.5) === 100);
check('boostedAmount-clamps-negative-multiplier-to-1.0', HB.boostedAmount(100, -3) === 100);
check('boostedAmount-clamps-zero-multiplier-to-1.0', HB.boostedAmount(100, 0) === 100);
check('boostedAmount-NaN-multiplier-treated-as-1.0', HB.boostedAmount(100, NaN) === 100);
check('boostedAmount-Infinity-multiplier-treated-as-1.0', HB.boostedAmount(100, Infinity) === 100);
check('boostedAmount-non-number-multiplier-treated-as-1.0', HB.boostedAmount(100, 'x') === 100);
check('boostedAmount-null-multiplier-treated-as-1.0', HB.boostedAmount(100, null) === 100);
check('boostedAmount-undefined-multiplier-treated-as-1.0', HB.boostedAmount(100, undefined) === 100);
check('boostedAmount-zero-amount-is-zero', HB.boostedAmount(0, 2.0) === 0);
check('boostedAmount-negative-amount-is-zero', HB.boostedAmount(-5, 2.0) === 0);
check('boostedAmount-fractional-amount-is-zero', HB.boostedAmount(1.5, 2.0) === 0);
check('boostedAmount-non-number-amount-is-zero', HB.boostedAmount('x', 2.0) === 0);
check('boostedAmount-null-amount-is-zero', HB.boostedAmount(null, 2.0) === 0);
check('boostedAmount-undefined-amount-is-zero', HB.boostedAmount(undefined, 2.0) === 0);
check('boostedAmount-NaN-amount-is-zero', HB.boostedAmount(NaN, 2.0) === 0);
check('boostedAmount-never-throws-on-garbage', (function () {
  try {
    HB.boostedAmount(undefined, undefined);
    HB.boostedAmount(null, null);
    HB.boostedAmount('x', 'y');
    HB.boostedAmount({}, []);
    HB.boostedAmount(NaN, Infinity);
    return true;
  } catch (e) { return false; }
})());

// ---------------------------------------------------------------- boostedReward()
check('boostedReward-boosts-both-legs', (function () {
  const r = HB.boostedReward({ gold: 10, token: 20 }, 1.5);
  return r.gold === 15 && r.token === 30;
})());
check('boostedReward-preserves-shape', (function () {
  const r = HB.boostedReward({ gold: 10, token: 20 }, 1.25);
  const keys = Object.keys(r).sort();
  return keys.length === 2 && keys[0] === 'gold' && keys[1] === 'token';
})());
check('boostedReward-independent-legs', (function () {
  const r = HB.boostedReward({ gold: 3, token: 7 }, 1.10); // gold 3.3->3, token 7.7->7
  return r.gold === 3 && r.token === 7;
})());
check('boostedReward-missing-gold-treated-as-0', (function () {
  const r = HB.boostedReward({ token: 20 }, 2.0);
  return r.gold === 0 && r.token === 40;
})());
check('boostedReward-missing-token-treated-as-0', (function () {
  const r = HB.boostedReward({ gold: 20 }, 2.0);
  return r.gold === 40 && r.token === 0;
})());
check('boostedReward-empty-object', (function () {
  const r = HB.boostedReward({}, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-null-reward-never-throws', (function () {
  const r = HB.boostedReward(null, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-undefined-reward-never-throws', (function () {
  const r = HB.boostedReward(undefined, 2.0);
  return r.gold === 0 && r.token === 0;
})());
check('boostedReward-returns-fresh-object-not-input', (function () {
  const input = { gold: 10, token: 20 };
  const r = HB.boostedReward(input, 1.5);
  return r !== input;
})());
check('boostedReward-does-not-mutate-input', (function () {
  const input = { gold: 10, token: 20 };
  HB.boostedReward(input, 1.5);
  return input.gold === 10 && input.token === 20;
})());
check('boostedReward-1.0-multiplier-no-op', (function () {
  const r = HB.boostedReward({ gold: 5, token: 9 }, 1.0);
  return r.gold === 5 && r.token === 9;
})());
check('boostedReward-malformed-multiplier-defaults-to-no-boost', (function () {
  const r = HB.boostedReward({ gold: 5, token: 9 }, 'bad');
  return r.gold === 5 && r.token === 9;
})());

// end-to-end: multiplierFor feeding boostedReward for every tier boundary
check('end-to-end-tier-boundaries-boost-correctly', (function () {
  const cases = [
    [0, 1.0], [99, 1.0], [100, 1.10], [999, 1.10],
    [1000, 1.25], [9999, 1.25], [10000, 1.50], [99999, 1.50],
    [100000, 2.00], [50000000, 2.00]
  ];
  return cases.every(([balance, expectedMult]) => {
    const m = HB.multiplierFor(balance);
    if (m !== expectedMult) return false;
    const r = HB.boostedReward({ gold: 100, token: 100 }, m);
    return r.gold === Math.floor(100 * expectedMult) && r.token === Math.floor(100 * expectedMult);
  });
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/holder-bonus.js', 'utf8')
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
  typeof HB.BASE_MULTIPLIER === 'number' && Array.isArray(HB.TIERS) &&
  typeof HB.tierFor === 'function' && typeof HB.multiplierFor === 'function' &&
  typeof HB.boostedAmount === 'function' && typeof HB.boostedReward === 'function');

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
