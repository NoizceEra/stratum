/* test-crafting.js — assertions for src/crafting.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const CR = require('./src/crafting.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- validateBatchCount()
check('validateBatchCount-ok-min', (function () {
  const r = CR.validateBatchCount(1);
  return r.ok === true && r.count === 1;
})());
check('validateBatchCount-ok-max', (function () {
  const r = CR.validateBatchCount(CR.MAX_BATCH);
  return r.ok === true && r.count === CR.MAX_BATCH;
})());
check('validateBatchCount-refuses-zero', CR.validateBatchCount(0).ok === false);
check('validateBatchCount-refuses-negative', CR.validateBatchCount(-1).ok === false);
check('validateBatchCount-refuses-fractional', CR.validateBatchCount(1.5).ok === false);
check('validateBatchCount-refuses-over-max', CR.validateBatchCount(CR.MAX_BATCH + 1).ok === false);
check('validateBatchCount-refuses-non-number', CR.validateBatchCount('lots').ok === false);
check('validateBatchCount-never-throws-on-garbage', (function () {
  try { CR.validateBatchCount(undefined); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- batchCost()
check('batchCost-scales-every-key', (function () {
  const r = CR.batchCost({ wood: 2, ore: 1 }, 3);
  return r.wood === 6 && r.ore === 3;
})());
check('batchCost-count-of-1-is-unchanged', (function () {
  const r = CR.batchCost({ wood: 2, ore: 1 }, 1);
  return r.wood === 2 && r.ore === 1;
})());
check('batchCost-returns-fresh-object-never-mutates-input', (function () {
  const inputs = { wood: 2 };
  const r = CR.batchCost(inputs, 5);
  return inputs.wood === 2 && r.wood === 10 && r !== inputs;
})());
check('batchCost-null-on-bad-inputs', CR.batchCost(null, 3) === null);
check('batchCost-null-on-bad-count', CR.batchCost({ wood: 2 }, 0) === null);
check('batchCost-null-on-fractional-count', CR.batchCost({ wood: 2 }, 1.5) === null);
check('batchCost-null-on-negative-value-in-inputs', CR.batchCost({ wood: -1 }, 3) === null);
check('batchCost-never-throws-on-garbage', (function () {
  try { CR.batchCost('nope', 'nope'); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- batchOutputCount()
check('batchOutputCount-multiplies', CR.batchOutputCount(1, 5) === 5);
check('batchOutputCount-multi-output-recipe', CR.batchOutputCount(3, 4) === 12);
check('batchOutputCount-null-on-bad-args', CR.batchOutputCount(0, 5) === null && CR.batchOutputCount(1, 0) === null);
check('batchOutputCount-never-throws-on-garbage', CR.batchOutputCount('x', 'y') === null);

// ---------------------------------------------------------------- salvageRefund()
check('salvageRefund-default-50-percent', (function () {
  const r = CR.salvageRefund({ wood: 4, ore: 2 });
  return r.wood === 2 && r.ore === 1;
})());
check('salvageRefund-floors-odd-amounts', (function () {
  const r = CR.salvageRefund({ wood: 3 }); // 3*5000/10000 = 1.5 -> floors to 1
  return r.wood === 1;
})());
check('salvageRefund-never-exceeds-what-was-paid', (function () {
  const inputs = { wood: 4, ore: 2, herb: 2 };
  const r = CR.salvageRefund(inputs);
  return r.wood <= inputs.wood && r.ore <= inputs.ore && r.herb <= inputs.herb;
})());
check('salvageRefund-zero-refund-key-omitted-not-zeroed', (function () {
  const r = CR.salvageRefund({ wood: 1 }); // 1*5000/10000 = 0.5 -> floors to 0 -> omitted
  return !('wood' in r);
})());
check('salvageRefund-100-percent-bps', (function () {
  const r = CR.salvageRefund({ wood: 4 }, 10000);
  return r.wood === 4;
})());
check('salvageRefund-0-percent-bps-refunds-nothing', (function () {
  const r = CR.salvageRefund({ wood: 4 }, 0);
  return !('wood' in r);
})());
check('salvageRefund-bad-bps-falls-back-to-default', (function () {
  const r1 = CR.salvageRefund({ wood: 4 }, -1);
  const r2 = CR.salvageRefund({ wood: 4 }, 20000);
  const def = CR.salvageRefund({ wood: 4 });
  return r1.wood === def.wood && r2.wood === def.wood;
})());
check('salvageRefund-empty-object-on-bad-inputs', (function () {
  const r = CR.salvageRefund(null);
  return typeof r === 'object' && Object.keys(r).length === 0;
})());
check('salvageRefund-never-mutates-input', (function () {
  const inputs = { wood: 4 };
  CR.salvageRefund(inputs);
  return inputs.wood === 4;
})());
check('salvageRefund-never-throws-on-garbage', (function () {
  try { CR.salvageRefund('nope', 'nope'); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- batchSalvageRefund()
check('batchSalvageRefund-sums-per-item-floors-not-one-big-floor', (function () {
  // Salvaging 3 separate 3-wood items (1 wood refund each, floored) must total 3, not
  // floor(3*3*5000/10000)=4 — a single big floor would make bulk salvage strictly better.
  const perItem = CR.batchSalvageRefund({ wood: 3 }, 3);
  const oneAtATimeTotal = CR.salvageRefund({ wood: 3 }).wood * 3;
  return perItem.wood === oneAtATimeTotal && perItem.wood === 3;
})());
check('batchSalvageRefund-count-of-1-matches-salvageRefund', (function () {
  const a = CR.batchSalvageRefund({ wood: 4, ore: 2 }, 1);
  const b = CR.salvageRefund({ wood: 4, ore: 2 });
  return a.wood === b.wood && a.ore === b.ore;
})());
check('batchSalvageRefund-null-on-bad-args', CR.batchSalvageRefund(null, 3) === null && CR.batchSalvageRefund({ wood: 1 }, 0) === null);
check('batchSalvageRefund-never-throws-on-garbage', (function () {
  try { CR.batchSalvageRefund('nope', 'nope', 'nope'); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- validateSalvageCount()
check('validateSalvageCount-ok-partial', (function () {
  const r = CR.validateSalvageCount(2, 5);
  return r.ok === true && r.count === 2;
})());
check('validateSalvageCount-ok-all', (function () {
  const r = CR.validateSalvageCount(5, 5);
  return r.ok === true && r.count === 5;
})());
check('validateSalvageCount-refuses-more-than-held', CR.validateSalvageCount(6, 5).ok === false);
check('validateSalvageCount-refuses-zero-count', CR.validateSalvageCount(0, 5).ok === false);
check('validateSalvageCount-refuses-negative-count', CR.validateSalvageCount(-1, 5).ok === false);
check('validateSalvageCount-refuses-fractional-count', CR.validateSalvageCount(1.5, 5).ok === false);
check('validateSalvageCount-refuses-zero-held', CR.validateSalvageCount(1, 0).ok === false);
check('validateSalvageCount-refuses-negative-held', CR.validateSalvageCount(1, -3).ok === false);
check('validateSalvageCount-never-throws-on-garbage', (function () {
  try { CR.validateSalvageCount(undefined, undefined); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/crafting.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
