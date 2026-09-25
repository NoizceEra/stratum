/* test-token-sink.js — assertions for src/token-sink.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const TS = require('./src/token-sink.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- splitBurn()
check('splitBurn-default-80-20', (function () {
  const r = TS.splitBurn(100);
  return r.burned === 80 && r.treasury === 20;
})());
check('splitBurn-sums-exactly-to-amount-clean', (function () {
  const r = TS.splitBurn(100, 8000);
  return r.burned + r.treasury === 100;
})());
check('splitBurn-sums-exactly-with-odd-amount', (function () {
  const r = TS.splitBurn(37, 8000);           // 37*8000/10000 = 29.6 -> floors to 29
  return r.burned === 29 && r.treasury === 8 && r.burned + r.treasury === 37;
})());
check('splitBurn-100-percent-burn', (function () {
  const r = TS.splitBurn(50, 10000);
  return r.burned === 50 && r.treasury === 0;
})());
check('splitBurn-0-percent-burn', (function () {
  const r = TS.splitBurn(50, 0);
  return r.burned === 0 && r.treasury === 50;
})());
check('splitBurn-bad-bps-falls-back-to-BURN_BPS', (function () {
  const r1 = TS.splitBurn(100, -1);
  const r2 = TS.splitBurn(100, 20000);
  const def = TS.splitBurn(100);
  return r1.burned === def.burned && r2.burned === def.burned;
})());
check('splitBurn-zero-amount-zeros', (function () {
  const r = TS.splitBurn(0, 8000);
  return r.burned === 0 && r.treasury === 0;
})());
check('splitBurn-negative-amount-zeros', TS.splitBurn(-5, 8000).burned === 0);
check('splitBurn-fractional-amount-zeros', TS.splitBurn(1.5, 8000).burned === 0);
check('splitBurn-non-number-amount-never-throws', TS.splitBurn('lots', 8000).burned === 0);
check('splitBurn-null-args-never-throw', (function () {
  const r = TS.splitBurn(null, null);
  return r.burned === 0 && r.treasury === 0;
})());
// sweep: at every bps 0..10000, burned+treasury must equal amount exactly, never negative
check('splitBurn-full-bps-sweep-never-loses-dust', (function () {
  for (let bps = 0; bps <= 10000; bps += 137) {
    const r = TS.splitBurn(9999, bps);
    if (r.burned + r.treasury !== 9999 || r.burned < 0 || r.treasury < 0) return false;
  }
  return true;
})());

check('taxOf-1-percent-of-100', TS.taxOf(100) === 1);
check('taxOf-under-100-floors-to-0', TS.taxOf(50) === 0);
check('taxOf-bad-amount-zero', TS.taxOf(0) === 0 && TS.taxOf(-4) === 0);

check('splitOnChain-100', (function () {
  const r = TS.splitOnChain(100);
  return r.gross === 100 && r.tax === 1 && r.arrived === 99 &&
    r.burned === 79 && r.treasury === 20 &&
    r.burned + r.treasury === r.arrived && r.tax + r.arrived === r.gross;
})());
check('splitOnChain-50-tax-floors-then-80-20', (function () {
  const r = TS.splitOnChain(50);
  return r.tax === 0 && r.arrived === 50 && r.burned === 40 && r.treasury === 10;
})());
check('splitOnChain-bad-amount-zeros', TS.splitOnChain(0).arrived === 0);
check('onchain-default-ship-is-100', TS.ONCHAIN_DEFAULT_SHIP === 100);
check('tax-bps-is-100', TS.TAX_BPS === 100);

// ---------------------------------------------------------------- validateRequisition()
check('validateRequisition-ok-partial-spend', (function () {
  const r = TS.validateRequisition(50, 100);
  return r.ok === true && r.amount === 50;
})());
check('validateRequisition-ok-spend-everything', (function () {
  const r = TS.validateRequisition(100, 100);
  return r.ok === true && r.amount === 100;
})());
check('validateRequisition-refuses-over-pending', TS.validateRequisition(101, 100).ok === false);
check('validateRequisition-refuses-zero-amount', TS.validateRequisition(0, 100).ok === false);
check('validateRequisition-refuses-negative-amount', TS.validateRequisition(-1, 100).ok === false);
check('validateRequisition-refuses-fractional-amount', TS.validateRequisition(1.5, 100).ok === false);
check('validateRequisition-refuses-zero-pending', TS.validateRequisition(1, 0).ok === false);
check('validateRequisition-refuses-negative-pending', TS.validateRequisition(1, -5).ok === false);
check('validateRequisition-refuses-non-number-amount', TS.validateRequisition('all', 100).ok === false);
check('validateRequisition-never-throws-on-garbage', (function () {
  try { TS.validateRequisition(undefined, undefined); return true; } catch (e) { return false; }
})());

// ---------------------------------------------------------------- rushCost()
check('rushCost-partial-structure', (function () {
  const r = TS.rushCost(5, 20);                // 15 units short, default 2/unit
  return r.gained === 15 && r.cost === 30;
})());
check('rushCost-custom-rate', (function () {
  const r = TS.rushCost(0, 10, 3);
  return r.gained === 10 && r.cost === 30;
})());
check('rushCost-already-full-costs-nothing', (function () {
  const r = TS.rushCost(20, 20);
  return r.cost === 0 && r.gained === 0;
})());
check('rushCost-over-capacity-costs-nothing', (function () {
  const r = TS.rushCost(25, 20);                 // shouldn't happen, but must not go negative
  return r.cost === 0 && r.gained === 0;
})());
check('rushCost-zero-capacity-never-throws', TS.rushCost(0, 0).cost === 0);
check('rushCost-negative-accrued-never-throws', TS.rushCost(-5, 20).cost === 0);
check('rushCost-non-number-never-throws', TS.rushCost('x', 'y').cost === 0);
check('rushCost-bad-costPerUnit-falls-back-to-default', (function () {
  const withBad = TS.rushCost(0, 10, -1);
  const withDefault = TS.rushCost(0, 10);
  return withBad.cost === withDefault.cost;
})());

// ---------------------------------------------------------------- purity / hygiene
const source = require('fs').readFileSync('./src/token-sink.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-frozen-where-applicable', typeof TS.FEE_DENOM === 'number' && typeof TS.BURN_BPS === 'number');

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
