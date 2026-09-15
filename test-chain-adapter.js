/* test-chain-adapter.js — assertions for src/chain-adapter.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const CA = require('./src/chain-adapter.js');
const TC = require('./src/token-config.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

const HEX_KEY = '0x' + '1'.repeat(64);
const BAD_KEY = 'not-a-real-key-this-is-a-test-fixture';
const TOKEN = '0x' + 'a'.repeat(40);
const TREASURY = TC.DEFAULTS.treasuryAddress;
const WALLET = '0x' + 'b'.repeat(40);

// ---------------------------------------------------------------- describe()
const empty = CA.describe({});
check('describe-empty-env-nothing-configured',
  empty.rpcConfigured === false && empty.tokenConfigured === false &&
  empty.treasuryConfigured === false && empty.signerPresent === false);
check('describe-settlementImplemented-always-false', empty.settlementImplemented === false);

const fullEnv = {
  STRATUM_CLAIM_RPC_URL: 'https://sepolia.example.org/rpc',
  STRATUM_CLAIM_TOKEN_ADDR: TOKEN,
  STRATUM_TREASURY_ADDRESS: TREASURY,
  STRATUM_CLAIM_SIGNER_KEY: HEX_KEY
};
const full = CA.describe(fullEnv);
check('describe-full-env-flags-all-present',
  full.rpcConfigured === true && full.tokenConfigured === true &&
  full.treasuryConfigured === true && full.signerPresent === true);
check('describe-even-full-env-settlement-not-implemented', full.settlementImplemented === false);

check('describe-bad-rpc-url-rejected', CA.describe({ STRATUM_CLAIM_RPC_URL: 'not-a-url' }).rpcConfigured === false);
check('describe-bad-token-addr-rejected', CA.describe({ STRATUM_CLAIM_TOKEN_ADDR: '0xtooshort' }).tokenConfigured === false);
check('describe-empty-signer-key-rejected', CA.describe({ STRATUM_CLAIM_SIGNER_KEY: '' }).signerPresent === false);
check('describe-non-hex-signer-key-rejected', CA.describe({ STRATUM_CLAIM_SIGNER_KEY: BAD_KEY }).signerPresent === false);
check('describe-malformed-env-never-throws', CA.describe(null).rpcConfigured === false);
check('describe-non-object-env-never-throws', CA.describe('nope').rpcConfigured === false);

check('describe-rpc-alias-STRATUM_RPC_URL',
  CA.describe({ STRATUM_RPC_URL: 'https://rpc.example.com' }).rpcConfigured === true);
check('describe-token-alias-STRATUM_TOKEN_ADDRESS',
  CA.describe({ STRATUM_TOKEN_ADDRESS: TOKEN }).tokenConfigured === true);
check('describe-key-alias-STRATUM_TREASURY_KEY',
  CA.describe({ STRATUM_TREASURY_KEY: HEX_KEY }).signerPresent === true);
check('describe-never-echoes-key', (function () {
  const d = CA.describe(fullEnv);
  return JSON.stringify(d).indexOf('11111111') === -1;
})());

// ---------------------------------------------------------------- isConfigured()
check('isConfigured-false-on-empty-env', CA.isConfigured({}) === false);
check('isConfigured-false-even-with-every-var-set', CA.isConfigured(fullEnv) === false);
check('isConfigured-malformed-env-never-throws', CA.isConfigured(null) === false);
check('isConfigured-false-without-treasury', CA.isConfigured({
  STRATUM_CLAIM_RPC_URL: fullEnv.STRATUM_CLAIM_RPC_URL,
  STRATUM_CLAIM_TOKEN_ADDR: TOKEN,
  STRATUM_CLAIM_SIGNER_KEY: HEX_KEY
}) === false);

// ---------------------------------------------------------------- settleClaim()
(async function () {
  const r1 = await CA.settleClaim({ key: 'p1', amountUnits: 100, wallet: WALLET }, {});
  check('settleClaim-not-configured-by-default', r1.ok === false && r1.reason === 'not_configured');

  const r2 = await CA.settleClaim({ key: 'p1', amountUnits: 100, wallet: WALLET }, fullEnv);
  check('settleClaim-still-not-configured-with-full-env', r2.ok === false && r2.reason === 'not_configured');
  check('settleClaim-detail-lists-missing-implementation',
    typeof r2.detail === 'string' && r2.detail.indexOf('settlement implementation') >= 0);

  const r3 = await CA.settleClaim(null, {});
  check('settleClaim-bad-request-never-throws', r3.ok === false && r3.reason === 'bad_request');

  const r4 = await CA.settleClaim('nope', {});
  check('settleClaim-non-object-request-never-throws', r4.ok === false && r4.reason === 'bad_request');

  const r5 = await CA.settleClaim({ key: 'p1', amountUnits: 1 }, fullEnv);
  check('settleClaim-missing-wallet-is-bad-request', r5.ok === false && r5.reason === 'bad_request');

  const r6 = await CA.settleClaim({ key: 'p1', amountUnits: 0, wallet: WALLET }, fullEnv);
  check('settleClaim-zero-amount-is-bad-request', r6.ok === false && r6.reason === 'bad_request');

  const r7 = await CA.settleClaim({ key: 'p1', amountUnits: 1, wallet: WALLET }, fullEnv);
  check('settleClaim-never-reports-ok-true-today', r7.ok === false);

  // ---------------------------------------------------------------- purity / hygiene
  const source = require('fs').readFileSync('./src/chain-adapter.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  check('source-touches-no-network-or-signing-primitive',
    source.indexOf('http.request') === -1 && source.indexOf('https.request') === -1 &&
    source.indexOf('fetch(') === -1 && source.indexOf('createSign') === -1 &&
    source.indexOf('createECDH') === -1);
  check('source-has-no-require-of-project-files', source.indexOf("require('./") === -1 && source.indexOf('require("./') === -1);

  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
