'use strict';
/* test-vault.js — pure unit tests for src/vault.js (STRATUM staking pool).
 * No server, no sockets. */
const V = require('./src/vault.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

check('min-deposit', V.MIN_DEPOSIT === 100);
check('fees', V.DEPOSIT_FEE_BPS === 100 && V.WITHDRAW_FEE_BPS === 250 && V.FEE_DENOM === 10000);

check('deposit-ok', JSON.stringify(V.validateDeposit(500, 500)) ===
  JSON.stringify({ ok: true, gross: 500, fee: 5, net: 495, error: null }));
check('deposit-min', V.validateDeposit(100, 100).ok === true);
check('deposit-below-min', V.validateDeposit(99, 999).error === 'minimum deposit 100');
check('deposit-broke', V.validateDeposit(500, 499).error === 'cannot afford');
check('deposit-garbage', V.validateDeposit(null, null).ok === false && V.validateDeposit(-5, 99).ok === false);

check('withdraw-ok', JSON.stringify(V.validateWithdraw(400, 400)) ===
  JSON.stringify({ ok: true, gross: 400, fee: 10, net: 390, error: null }));
check('withdraw-over', V.validateWithdraw(401, 400).error === 'cannot afford');
check('withdraw-empty', V.validateWithdraw(100, 0).error === 'nothing deposited');
check('withdraw-dust-no-fee', JSON.stringify(V.validateWithdraw(1, 100)) ===
  JSON.stringify({ ok: true, gross: 1, fee: 0, net: 1, error: null }));
check('withdraw-garbage', V.validateWithdraw('x', 'y').ok === false);

check('emission-solo', JSON.stringify(V.emissionShares([{ key: 'a', balance: 495 }], 25000)) ===
  JSON.stringify([{ key: 'a', share: 25000 }]));
check('emission-split', (function () {
  const out = V.emissionShares([{ key: 'a', balance: 1 }, { key: 'b', balance: 3 }], 100);
  const sum = out[0].share + out[1].share;
  return sum === 100 && out[1].share >= out[0].share;
})());
check('emission-empty', V.emissionShares([], 25000).length === 0 && V.emissionShares([{ key: 'a', balance: 0 }], 100).length === 0);
check('emission-never-throws', (function () {
  try { V.emissionShares(null, null); V.emissionShares('x', -5); return true; } catch (e) { return false; }
})());

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
