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
check('tc-defaults-cluster', TC.DEFAULTS.cluster === 'mainnet-beta');
check('tc-defaults-chain-name', TC.DEFAULTS.chainName === 'Solana');
check('tc-defaults-mint-is-the-real-strm-mint', TC.DEFAULTS.tokenMint === 'EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU');
check('tc-defaults-treasury', TC.DEFAULTS.treasuryAddress === 'AYMwwmPxucSXDoc3Qx7prVnH5rP3XpgBDJVENed4A9mo');
check('tc-defaults-placeholder', TC.DEFAULTS.placeholder === false);
check('tc-defaults-symbol', TC.DEFAULTS.symbol === 'STRATUM');
check('tc-defaults-decimals', TC.DEFAULTS.decimals === 6);
check('tc-frozen', Object.isFrozen(TC.DEFAULTS));
check('tc-isAddr-ok', TC.isAddr('AYMwwmPxucSXDoc3Qx7prVnH5rP3XpgBDJVENed4A9mo'));
check('tc-isAddr-evm-no-longer-ok', TC.isAddr('0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7') === false);
check('tc-isAddr-bad', TC.isAddr('not-an-address') === false);
check('tc-public-has-mint', TC.publicConfig().tokenMint === TC.DEFAULTS.tokenMint);
check('tc-public-has-treasury', TC.publicConfig().treasuryAddress === TC.DEFAULTS.treasuryAddress);
check('tc-public-no-key-field', !('privateKey' in TC.publicConfig()) && !('signerKey' in TC.publicConfig()) && !('secretKey' in TC.publicConfig()));
check('tc-treasury-link', TC.explorerTreasuryLink().indexOf(TC.DEFAULTS.treasuryAddress) >= 0);

var enved = TC.withEnv({
  STRATUM_TOKEN_MINT: 'So11111111111111111111111111111111111111112',
  STRATUM_TREASURY_ADDRESS: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  STRATUM_CLUSTER: 'devnet',
  STRATUM_TOKEN_SYMBOL: 'GOLDX',
  STRATUM_TOKEN_DECIMALS: '6'
});
check('tc-env-mint', enved.tokenMint === 'So11111111111111111111111111111111111111112');
check('tc-env-treasury', enved.treasuryAddress === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
check('tc-env-cluster', enved.cluster === 'devnet');
check('tc-env-clears-placeholder', enved.placeholder === false);
check('tc-env-symbol', enved.symbol === 'GOLDX');
check('tc-env-decimals', enved.decimals === 6);
check('tc-env-bad-mint-ignored', TC.withEnv({ STRATUM_TOKEN_MINT: 'nope' }).tokenMint === TC.DEFAULTS.tokenMint);
check('tc-env-evm-mint-ignored', TC.withEnv({ STRATUM_TOKEN_MINT: '0x1111111111111111111111111111111111111111' }).tokenMint === TC.DEFAULTS.tokenMint);
check('tc-env-out-of-range-decimals-falls-back-to-default', TC.withEnv({ STRATUM_TOKEN_DECIMALS: '18' }).decimals === TC.DEFAULTS.decimals);
check('tc-explorer-link', TC.explorerTokenLink().indexOf(TC.DEFAULTS.tokenMint) >= 0);

var CA = require('./src/chain-adapter.js');
check('ca-not-configured-empty', CA.isConfigured({}) === false);
check('ca-describe-missing', (function () {
  var d = CA.describe({});
  // settlementImplemented tracks whether the signing code exists (it does — see
  // chain-adapter.js), not whether this particular call would succeed; isConfigured()
  // above is still the real "would a claim actually settle" answer.
  return d.signerPresent === false && d.treasuryConfigured === false && d.settlementImplemented === true;
})());
check('ca-describe-with-key-presence-only', (function () {
  // Dummy secret (JSON-array form) for shape/presence checks ONLY — a throwaway
  // keypair generated on the spot, never the real treasury key.
  var dummyKp = require('@solana/web3.js').Keypair.generate();
  var dummyKey = JSON.stringify(Array.from(dummyKp.secretKey));
  var d = CA.describe({
    STRATUM_SOLANA_RPC: 'https://api.mainnet-beta.solana.com',
    STRATUM_TOKEN_MINT: TC.DEFAULTS.tokenMint === 'STRM_MINT_NOT_YET_DEPLOYED'
      ? 'So11111111111111111111111111111111111111112' : TC.DEFAULTS.tokenMint,
    STRATUM_TREASURY_ADDRESS: TC.DEFAULTS.treasuryAddress,
    STRATUM_CLAIM_SIGNER_KEY: dummyKey
  });
  // Key presence is visible as a boolean — the key value must never appear in describe()
  var blob = JSON.stringify(d);
  return d.signerPresent === true && d.treasuryConfigured === true && d.rpcConfigured === true &&
    d.mintConfigured === true && d.settlementImplemented === true &&
    // Still not actually configured: this env never says the mint is a real (non-
    // placeholder) mint, which isConfigured() requires — see chain-adapter.js.
    CA.isConfigured({
      STRATUM_SOLANA_RPC: 'https://api.mainnet-beta.solana.com',
      STRATUM_TOKEN_MINT: 'So11111111111111111111111111111111111111112',
      STRATUM_TREASURY_ADDRESS: TC.DEFAULTS.treasuryAddress,
      STRATUM_CLAIM_SIGNER_KEY: dummyKey
    }) === false &&
    blob.indexOf(String(dummyKp.secretKey[0]) + ',' + String(dummyKp.secretKey[1])) === -1;
})());

// ---- rewards ----
check('actions-4', R.ACTIONS.length === 4);
// Rates bumped 2026-09-21 ("increased yields" pass) — harvest doubled (1->2/1->2,
// mining is the primary activity), others raised ~1.5x. See src/rewards.js's RATES
// comment for the full reasoning.
check('harvest', (function () {
  var r = R.rewardFor('harvest');
  return r.gold === 2 && r.token === 2;
})());
check('craft-tier0', (function () {
  var r = R.rewardFor('craft', { tier: 0 });
  return r.gold === 3 && r.token === 3;
})());
check('craft-tier3', (function () {
  var r = R.rewardFor('craft', { tier: 3 });
  return r.gold === 9 && r.token === 3; // 3 + 2*3
})());
check('kill-flat', (function () {
  var r = R.rewardFor('kill');
  return r.gold === 3 && r.token === 3;
})());
check('kill-xp-bonus', (function () {
  var r = R.rewardFor('kill', { xp: 25 });
  return r.gold === 3 && r.token === 5; // 3 + floor(25/10)
})());
check('collect-gold-only', (function () {
  var r = R.rewardFor('collect');
  return r.gold === 2 && r.token === 0;
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
