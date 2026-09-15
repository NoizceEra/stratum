/* test-rewards.js — assertions for src/rewards.js + src/token-config.js */
'use strict';
var R = require('./src/rewards.js');
var TC = require('./src/token-config.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---- token-config ----
check('tc-defaults-chain', TC.DEFAULTS.chainId === 4663);
check('tc-defaults-ca', TC.DEFAULTS.tokenAddress.toLowerCase() === '0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7');
check('tc-defaults-placeholder', TC.DEFAULTS.placeholder === true);
check('tc-defaults-symbol', TC.DEFAULTS.symbol === 'STRM');
check('tc-frozen', Object.isFrozen(TC.DEFAULTS));
check('tc-isAddr-ok', TC.isAddr('0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7'));
check('tc-isAddr-bad', TC.isAddr('not-an-address') === false);
check('tc-public-has-ca', TC.publicConfig().tokenAddress === TC.DEFAULTS.tokenAddress);

var enved = TC.withEnv({
  STRATUM_TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
  STRATUM_CHAIN_ID: '4663',
  STRATUM_TOKEN_SYMBOL: 'GOLDX',
  STRATUM_TOKEN_DECIMALS: '9'
});
check('tc-env-address', enved.tokenAddress === '0x1111111111111111111111111111111111111111');
check('tc-env-clears-placeholder', enved.placeholder === false);
check('tc-env-symbol', enved.symbol === 'GOLDX');
check('tc-env-decimals', enved.decimals === 9);
check('tc-env-bad-addr-ignored', TC.withEnv({ STRATUM_TOKEN_ADDRESS: 'nope' }).tokenAddress === TC.DEFAULTS.tokenAddress);
check('tc-explorer-link', TC.explorerTokenLink().indexOf(TC.DEFAULTS.tokenAddress) >= 0);

// ---- rewards ----
check('actions-4', R.ACTIONS.length === 4);
check('harvest', (function () {
  var r = R.rewardFor('harvest');
  return r.gold === 1 && r.token === 1;
})());
check('craft-tier0', (function () {
  var r = R.rewardFor('craft', { tier: 0 });
  return r.gold === 2 && r.token === 2;
})());
check('craft-tier3', (function () {
  var r = R.rewardFor('craft', { tier: 3 });
  return r.gold === 5 && r.token === 2;
})());
check('kill-flat', (function () {
  var r = R.rewardFor('kill');
  return r.gold === 2 && r.token === 2;
})());
check('kill-xp-bonus', (function () {
  var r = R.rewardFor('kill', { xp: 25 });
  return r.gold === 2 && r.token === 4; // 2 + floor(25/10)
})());
check('collect-gold-only', (function () {
  var r = R.rewardFor('collect');
  return r.gold === 1 && r.token === 0;
})());
check('unknown-zero', (function () {
  var r = R.rewardFor('dance');
  return r.gold === 0 && r.token === 0;
})());
check('null-action-zero', R.rewardFor(null).gold === 0);
check('fresh-object', R.rewardFor('harvest') !== R.rewardFor('harvest'));
check('hasReward-true', R.hasReward(R.rewardFor('harvest')) === true);
check('hasReward-false', R.hasReward(R.rewardFor('nope')) === false);
check('rates-frozen', Object.isFrozen(R.RATES));

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
