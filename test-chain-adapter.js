/* test-chain-adapter.js — assertions for src/chain-adapter.js. PASS/FAIL per case, non-zero exit on failure.
 *
 * No test in this file ever touches a real network, signs a real transaction, or moves a
 * real cent of STRM — settleClaim()'s test-only `deps` argument (see that file's header)
 * swaps in fakes for the provider/wallet/contract, so `npm test` stays fully offline even
 * though the production code path now really does sign and broadcast via `ethers`.
 */
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
check('describe-settlementImplemented-is-true', empty.settlementImplemented === true);
check('describe-empty-env-token-still-flagged-placeholder', empty.tokenIsPlaceholder === true);

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
check('describe-full-env-without-explicit-0-flag-still-reads-as-placeholder',
  full.tokenIsPlaceholder === true);

// The one env combination that actually unlocks real settlement. Decimals pinned to 0 so
// the fake balances/amounts below can be compared as plain whole numbers, not wei-scaled.
const realEnv = Object.assign({}, fullEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: '0', STRATUM_TOKEN_DECIMALS: '0' });
check('describe-explicit-0-flag-clears-placeholder', CA.describe(realEnv).tokenIsPlaceholder === false);
check('describe-explicit-1-flag-stays-placeholder',
  CA.describe(Object.assign({}, realEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: '1' })).tokenIsPlaceholder === true);
check('describe-garbled-flag-value-stays-placeholder',
  CA.describe(Object.assign({}, realEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: 'nah' })).tokenIsPlaceholder === true);

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
check('isConfigured-false-on-full-env-still-placeholder', CA.isConfigured(fullEnv) === false);
check('isConfigured-true-only-with-real-flag-and-everything-else-present', CA.isConfigured(realEnv) === true);
check('isConfigured-malformed-env-never-throws', CA.isConfigured(null) === false);
check('isConfigured-false-without-treasury', CA.isConfigured({
  STRATUM_CLAIM_RPC_URL: fullEnv.STRATUM_CLAIM_RPC_URL,
  STRATUM_CLAIM_TOKEN_ADDR: TOKEN,
  STRATUM_CLAIM_SIGNER_KEY: HEX_KEY,
  STRATUM_TOKEN_IS_PLACEHOLDER: '0'
}) === false);
check('isConfigured-false-without-signer-even-when-marked-real', CA.isConfigured({
  STRATUM_CLAIM_RPC_URL: fullEnv.STRATUM_CLAIM_RPC_URL,
  STRATUM_CLAIM_TOKEN_ADDR: TOKEN,
  STRATUM_TREASURY_ADDRESS: TREASURY,
  STRATUM_TOKEN_IS_PLACEHOLDER: '0'
}) === false);

// ---------------------------------------------------------------- settleClaim() — not configured
(async function () {
  const r1 = await CA.settleClaim({ key: 'p1', amountUnits: 100, wallet: WALLET }, {});
  check('settleClaim-not-configured-by-default', r1.ok === false && r1.reason === 'not_configured');

  const r2 = await CA.settleClaim({ key: 'p1', amountUnits: 100, wallet: WALLET }, fullEnv);
  check('settleClaim-still-not-configured-while-placeholder', r2.ok === false && r2.reason === 'not_configured');
  check('settleClaim-detail-names-the-placeholder-as-whats-missing',
    typeof r2.detail === 'string' && r2.detail.indexOf('non-placeholder') >= 0);

  const r3 = await CA.settleClaim(null, {});
  check('settleClaim-bad-request-never-throws', r3.ok === false && r3.reason === 'bad_request');

  const r4 = await CA.settleClaim('nope', {});
  check('settleClaim-non-object-request-never-throws', r4.ok === false && r4.reason === 'bad_request');

  const r5 = await CA.settleClaim({ key: 'p1', amountUnits: 1 }, realEnv);
  check('settleClaim-missing-wallet-is-bad-request', r5.ok === false && r5.reason === 'bad_request');

  const r6 = await CA.settleClaim({ key: 'p1', amountUnits: 0, wallet: WALLET }, realEnv);
  check('settleClaim-zero-amount-is-bad-request', r6.ok === false && r6.reason === 'bad_request');

  const r6b = await CA.settleClaim({ key: 'p1', amountUnits: 1.5, wallet: WALLET }, realEnv);
  check('settleClaim-fractional-amount-is-bad-request', r6b.ok === false && r6b.reason === 'bad_request');

  // -------------------------------------------------------- settleClaim() — configured, fake chain
  // Every fake below is synchronous/offline — no DNS, no sockets, no real key material used
  // for anything but shape-checking. This exercises the real signing/transfer code path in
  // chain-adapter.js without ever reaching an actual RPC endpoint.
  function fakeDeps(overrides) {
    const contract = Object.assign({
      balanceOf: async function () { return 1000n; },
      transfer: async function (to, amount) {
        return { hash: '0xdeadbeef', wait: async function () { return { status: 1 }; } };
      }
    }, (overrides && overrides.contract) || {});
    return Object.assign({
      makeProvider: function (rpcUrl) { return { __fakeProvider: true, rpcUrl: rpcUrl }; },
      makeWallet: function (key, provider) {
        return { getAddress: async function () { return TREASURY; }, __fakeWallet: true, provider: provider };
      },
      makeContract: function (address, abi, signer) { return contract; }
    }, overrides || {});
  }

  const ok1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps());
  check('settleClaim-succeeds-against-a-fake-chain-with-sufficient-balance',
    ok1.ok === true && ok1.txHash === '0xdeadbeef');

  const lowBalDeps = fakeDeps({ contract: { balanceOf: async function () { return 1n; } } });
  const low1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, lowBalDeps);
  check('settleClaim-refuses-when-treasury-balance-is-insufficient',
    low1.ok === false && low1.reason === 'insufficient_treasury_balance');

  const balErrDeps = fakeDeps({ contract: { balanceOf: async function () { throw new Error('rpc down'); } } });
  const balErr1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, balErrDeps);
  check('settleClaim-reports-rpc_error-when-balance-read-fails',
    balErr1.ok === false && balErr1.reason === 'rpc_error');

  const revertDeps = fakeDeps({ contract: { transfer: async function () { throw new Error('execution reverted'); } } });
  const revert1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, revertDeps);
  check('settleClaim-reports-send_failed-when-transfer-throws',
    revert1.ok === false && revert1.reason === 'send_failed');

  const badStatusDeps = fakeDeps({
    contract: {
      transfer: async function () { return { hash: '0xabc', wait: async function () { return { status: 0 }; } }; }
    }
  });
  const badStatus1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, badStatusDeps);
  check('settleClaim-reports-tx_failed-when-receipt-status-is-not-1',
    badStatus1.ok === false && badStatus1.reason === 'tx_failed' && badStatus1.txHash === '0xabc');

  const signerErrDeps = { makeProvider: function () { throw new Error('bad rpc'); } };
  const signerErr1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, signerErrDeps);
  check('settleClaim-reports-signer_error-when-provider-construction-throws',
    signerErr1.ok === false && signerErr1.reason === 'signer_error');

  // Reaching this line at all — through five straight fake failure modes above, none of
  // which threw out of settleClaim() — is itself the "never throws" proof; every check
  // above exercises a distinct throwing fake, so no separate vacuous assertion is needed.

  // -------------------------------------------------------- settleClaim() — queue serializes real sends
  // The treasury is ONE signer with ONE nonce (see chain-adapter.js's file header). Two
  // settleClaim() calls fired without awaiting between them must never let their chain-
  // touching work (balanceOf + transfer) interleave — that's exactly how two claims could
  // race for the same nonce. Prove it with fakes that record whether a second call's work
  // ever started before the first one's finished.
  await (async function () {
    let inFlight = 0;
    let sawOverlap = false;
    const order = [];
    function trackingDeps(tag) {
      return fakeDeps({
        contract: {
          balanceOf: async function () {
            inFlight++;
            if (inFlight > 1) sawOverlap = true;
            await new Promise((r) => setTimeout(r, 15));
            order.push(tag + ':balanceOf');
            return 1000n;
          },
          transfer: async function () {
            await new Promise((r) => setTimeout(r, 15));
            order.push(tag + ':transfer');
            inFlight--;
            return { hash: '0x' + tag, wait: async function () { return { status: 1 }; } };
          }
        }
      });
    }
    const p1 = CA.settleClaim({ key: 'p1', amountUnits: 1, wallet: WALLET }, realEnv, trackingDeps('first'));
    const p2 = CA.settleClaim({ key: 'p2', amountUnits: 1, wallet: WALLET }, realEnv, trackingDeps('second'));
    const [r1, r2] = await Promise.all([p1, p2]);
    check('settleClaim-queue-never-lets-two-sends-overlap', sawOverlap === false);
    check('settleClaim-queue-runs-second-call-strictly-after-the-first-completes',
      order.join(',') === 'first:balanceOf,first:transfer,second:balanceOf,second:transfer');
    check('settleClaim-queue-both-queued-calls-still-succeed', r1.ok === true && r2.ok === true);
    check('settleClaim-queue-both-calls-get-their-own-txHash', r1.txHash === '0xfirst' && r2.txHash === '0xsecond');
  })();

  // ---------------------------------------------------------------- purity / hygiene
  const source = require('fs').readFileSync('./src/chain-adapter.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  check('source-never-logs-the-signer-key-env-var-name-outside-comments',
    source.indexOf('console.log') === -1);
  check('source-has-no-require-of-other-project-files',
    source.indexOf("require('./") === -1 && source.indexOf('require("./') === -1);
  check('source-requires-ethers-the-one-intentional-dependency',
    source.indexOf("require('ethers')") >= 0);

  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
