/* test-chain-adapter.js — assertions for src/chain-adapter.js (Solana SPL). PASS/FAIL per case, non-zero exit on failure.
 *
 * No test in this file ever touches a real network, signs a real transaction, or moves a
 * real cent of STRATUM — settleClaim()/readBalance()'s test-only `deps` argument (see that
 * file's header) swaps in a fake connection, so `npm test` stays fully offline even
 * though the production code path really does build and send an SPL transfer. ATA
 * derivation and instruction building run for real (they're pure/offline); only the
 * RPC round-trips are faked.
 */
'use strict';
const CA = require('./src/chain-adapter.js');
const TC = require('./src/token-config.js');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---- fixtures (all real keypairs/mints by construction, purely offline) ----
const treasuryKp = Keypair.generate();
const playerKp = Keypair.generate();
const MINT = 'So11111111111111111111111111111111111111112'; // valid base58 mint (wSOL)
const TREASURY = treasuryKp.publicKey.toBase58();
const WALLET = playerKp.publicKey.toBase58();
const SECRET_JSON = JSON.stringify(Array.from(treasuryKp.secretKey));

// tiny base58 encoder (test-only) so the base58 secret form gets exercised too
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s || '1';
}
const SECRET_B58 = b58encode(treasuryKp.secretKey);
const BAD_SECRET = 'not-a-real-secret-key';

// 165-byte SPL token account with `amount` (u64 LE at offset 64)
function tokenAcct(amount) {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(BigInt(amount), 64);
  return { data: b };
}

/**
 * Fake Connection. Distinguishes the mint + the two ATAs by address (derived with
 * the real spl-token helper, so derivation itself is genuinely exercised).
 */
function fakeConnection(opts) {
  const o = opts || {};
  const mint = new PublicKey(o.mint || MINT);
  const progId = o.mintProgramId || TOKEN_PROGRAM_ID;
  const tAta = getAssociatedTokenAddressSync(mint, treasuryKp.publicKey, false, progId).toBase58();
  const pAta = getAssociatedTokenAddressSync(mint, playerKp.publicKey, false, progId).toBase58();
  return {
    __fake: true,
    getAccountInfo: async function (pk) {
      const s = pk.toBase58();
      if (s === mint.toBase58()) return o.mintExists === false ? null : { data: Buffer.alloc(82), owner: progId };
      if (s === tAta) {
        if (o.noTreasuryAta) return null;
        return tokenAcct(o.treasuryRaw !== undefined ? o.treasuryRaw : 1000n);
      }
      if (s === pAta) {
        if (o.playerRaw !== undefined) return tokenAcct(o.playerRaw);
        return o.playerExists ? tokenAcct(0n) : null;
      }
      return null;
    },
    getLatestBlockhash: async function () {
      return { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hqUy', lastValidBlockHeight: 1000 };
    },
    getParsedTransaction: async function () {
      if (o.failParsedTx) throw new Error('rpc down');
      return o.parsedTx === undefined ? null : o.parsedTx;
    },
    sendRawTransaction: async function (raw) {
      if (o.failSend) throw new Error('send exploded');
      if (!raw || !raw.length) throw new Error('empty tx');
      return o.sig || 'sigTEST123';
    },
    confirmTransaction: async function () {
      if (o.failConfirm) throw new Error('confirm exploded');
      return { value: { err: null } };
    },
    getParsedTokenAccountsByOwner: async function () {
      if (o.failParsed) throw new Error('rpc down');
      return { value: o.parsed || [] };
    }
  };
}
function parsedBal(amountStr) {
  return [{ account: { data: { parsed: { info: { tokenAmount: { amount: amountStr, decimals: 0 } } } } } }];
}
function fakeDeps(connOpts) {
  return { makeConnection: function () { return fakeConnection(connOpts); } };
}

// ---------------------------------------------------------------- describe()
const empty = CA.describe({});
check('describe-empty-env-nothing-configured',
  empty.rpcConfigured === false && empty.mintConfigured === false &&
  empty.treasuryConfigured === false && empty.signerPresent === false);
check('describe-settlementImplemented-is-true', empty.settlementImplemented === true);
check('describe-empty-env-token-still-flagged-placeholder', empty.tokenIsPlaceholder === true);

const fullEnv = {
  STRATUM_SOLANA_RPC: 'https://api.mainnet-beta.solana.com',
  STRATUM_TOKEN_MINT: MINT,
  STRATUM_TREASURY_ADDRESS: TREASURY,
  STRATUM_CLAIM_SIGNER_KEY: SECRET_JSON
};
const full = CA.describe(fullEnv);
check('describe-full-env-flags-all-present',
  full.rpcConfigured === true && full.mintConfigured === true &&
  full.treasuryConfigured === true && full.signerPresent === true);
check('describe-full-env-without-explicit-0-flag-still-reads-as-placeholder',
  full.tokenIsPlaceholder === true);

// The one env combination that actually unlocks real settlement. Decimals pinned to 0 so
// the fake balances/amounts below can be compared as plain whole numbers, not scaled.
const realEnv = Object.assign({}, fullEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: '0', STRATUM_TOKEN_DECIMALS: '0' });
check('describe-explicit-0-flag-clears-placeholder', CA.describe(realEnv).tokenIsPlaceholder === false);
check('describe-explicit-1-flag-stays-placeholder',
  CA.describe(Object.assign({}, realEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: '1' })).tokenIsPlaceholder === true);
check('describe-garbled-flag-value-stays-placeholder',
  CA.describe(Object.assign({}, realEnv, { STRATUM_TOKEN_IS_PLACEHOLDER: 'nah' })).tokenIsPlaceholder === true);

check('describe-bad-rpc-url-rejected', CA.describe({ STRATUM_SOLANA_RPC: 'not-a-url' }).rpcConfigured === false);
check('describe-bad-mint-rejected', CA.describe({ STRATUM_TOKEN_MINT: 'nope!!' }).mintConfigured === false);
check('describe-evm-address-no-longer-a-valid-mint',
  CA.describe({ STRATUM_TOKEN_MINT: '0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7' }).mintConfigured === false);
check('describe-empty-signer-key-rejected', CA.describe({ STRATUM_CLAIM_SIGNER_KEY: '' }).signerPresent === false);
check('describe-non-secret-signer-key-rejected', CA.describe({ STRATUM_CLAIM_SIGNER_KEY: BAD_SECRET }).signerPresent === false);
check('describe-short-json-secret-rejected',
  CA.describe({ STRATUM_CLAIM_SIGNER_KEY: '[1,2,3]' }).signerPresent === false);
check('describe-base58-secret-accepted',
  CA.describe({ STRATUM_CLAIM_SIGNER_KEY: SECRET_B58 }).signerPresent === true);
check('describe-malformed-env-never-throws', CA.describe(null).rpcConfigured === false);
check('describe-non-object-env-never-throws', CA.describe('nope').rpcConfigured === false);

check('describe-rpc-alias-STRATUM_RPC_URL',
  CA.describe({ STRATUM_RPC_URL: 'https://rpc.example.com' }).rpcConfigured === true);
check('describe-rpc-alias-STRATUM_CLAIM_RPC_URL',
  CA.describe({ STRATUM_CLAIM_RPC_URL: 'https://rpc.example.com' }).rpcConfigured === true);
check('describe-mint-alias-STRATUM_TOKEN_ADDRESS',
  CA.describe({ STRATUM_TOKEN_ADDRESS: MINT }).mintConfigured === true);
check('describe-key-alias-STRATUM_TREASURY_KEY',
  CA.describe({ STRATUM_TREASURY_KEY: SECRET_JSON }).signerPresent === true);
check('describe-never-echoes-key', (function () {
  const d = CA.describe(fullEnv);
  const blob = JSON.stringify(d);
  return blob.indexOf(SECRET_B58.slice(0, 12)) === -1 && blob.indexOf(treasuryKp.secretKey[0] + ',' + treasuryKp.secretKey[1]) === -1;
})());

// ---------------------------------------------------------------- isConfigured()
check('isConfigured-false-on-empty-env', CA.isConfigured({}) === false);
check('isConfigured-false-on-full-env-still-placeholder', CA.isConfigured(fullEnv) === false);
check('isConfigured-true-only-with-real-flag-and-everything-else-present', CA.isConfigured(realEnv) === true);
check('isConfigured-malformed-env-never-throws', CA.isConfigured(null) === false);
check('isConfigured-false-without-treasury', CA.isConfigured({
  STRATUM_SOLANA_RPC: fullEnv.STRATUM_SOLANA_RPC,
  STRATUM_TOKEN_MINT: MINT,
  STRATUM_CLAIM_SIGNER_KEY: SECRET_JSON,
  STRATUM_TOKEN_IS_PLACEHOLDER: '0'
}) === false);
check('isConfigured-false-without-signer-even-when-marked-real', CA.isConfigured({
  STRATUM_SOLANA_RPC: fullEnv.STRATUM_SOLANA_RPC,
  STRATUM_TOKEN_MINT: MINT,
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

  const r5b = await CA.settleClaim({ key: 'p1', amountUnits: 1, wallet: '0xnotsolana' }, realEnv);
  check('settleClaim-evm-wallet-is-bad-request', r5b.ok === false && r5b.reason === 'bad_request');

  const r6 = await CA.settleClaim({ key: 'p1', amountUnits: 0, wallet: WALLET }, realEnv);
  check('settleClaim-zero-amount-is-bad-request', r6.ok === false && r6.reason === 'bad_request');

  const r6b = await CA.settleClaim({ key: 'p1', amountUnits: 1.5, wallet: WALLET }, realEnv);
  check('settleClaim-fractional-amount-is-bad-request', r6b.ok === false && r6b.reason === 'bad_request');

  // -------------------------------------------------------- settleClaim() — configured, fake chain
  const ok1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps());
  check('settleClaim-succeeds-against-a-fake-chain-with-sufficient-balance',
    ok1.ok === true && ok1.txHash === 'sigTEST123');

  // base58 secret form settles too (exercises b58decode -> Keypair end to end)
  const b58Env = Object.assign({}, realEnv, { STRATUM_CLAIM_SIGNER_KEY: SECRET_B58 });
  const okB58 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, b58Env, fakeDeps());
  check('settleClaim-succeeds-with-base58-secret-form', okB58.ok === true);

  const low1 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps({ treasuryRaw: 1n }));
  check('settleClaim-refuses-when-treasury-balance-is-insufficient',
    low1.ok === false && low1.reason === 'insufficient_treasury_balance');

  const noAta = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps({ noTreasuryAta: true }));
  check('settleClaim-refuses-when-treasury-has-no-token-account',
    noAta.ok === false && noAta.reason === 'insufficient_treasury_balance');

  const noMint = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps({ mintExists: false }));
  check('settleClaim-reports-bad_mint-when-mint-missing',
    noMint.ok === false && noMint.reason === 'bad_mint');

  // STRATUM's real STRATUM mint is Token-2022 (with a transfer-fee extension), not the
  // legacy Token program — settleClaim() must detect that from the mint account's own
  // `owner` field and derive/build against TOKEN_2022_PROGRAM_ID, not assume legacy.
  // A fixture using the legacy program id (every other case above) would derive
  // different ATAs than one using Token-2022 for the same mint+wallet, so this only
  // passes if the program-id detection is actually wired through end to end.
  const ok2022 = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv,
    fakeDeps({ mintProgramId: TOKEN_2022_PROGRAM_ID }));
  check('settleClaim-succeeds-against-a-token-2022-mint',
    ok2022.ok === true && ok2022.txHash === 'sigTEST123');

  const balErr = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, {
    makeConnection: function () {
      const c = fakeConnection();
      c.getAccountInfo = async function () { throw new Error('rpc down'); };
      return c;
    }
  });
  check('settleClaim-reports-rpc_error-when-balance-read-fails',
    balErr.ok === false && balErr.reason === 'rpc_error');

  const sendErr = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps({ failSend: true }));
  check('settleClaim-reports-send_failed-when-send-throws',
    sendErr.ok === false && sendErr.reason === 'send_failed');

  const confirmErr = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, fakeDeps({ failConfirm: true }));
  check('settleClaim-reports-send_failed-when-confirm-throws',
    confirmErr.ok === false && confirmErr.reason === 'send_failed');

  const connErr = await CA.settleClaim({ key: 'p1', amountUnits: 10, wallet: WALLET }, realEnv, {
    makeConnection: function () { throw new Error('bad rpc'); }
  });
  check('settleClaim-reports-signer_error-when-connection-construction-throws',
    connErr.ok === false && connErr.reason === 'signer_error');

  // -------------------------------------------------------- readBalance()
  const r1b = await CA.readBalance(WALLET, {});
  check('readBalance-not-configured-by-default', r1b.ok === false && r1b.reason === 'not_configured');

  const r2b = await CA.readBalance(WALLET, fullEnv);
  check('readBalance-still-not-configured-while-placeholder', r2b.ok === false && r2b.reason === 'not_configured');
  check('readBalance-detail-names-the-placeholder-as-whats-missing',
    typeof r2b.detail === 'string' && r2b.detail.indexOf('non-placeholder') >= 0);

  const r3b = await CA.readBalance('not-an-address', realEnv);
  check('readBalance-bad-address-is-bad-request', r3b.ok === false && r3b.reason === 'bad_request');

  const okRead = await CA.readBalance(WALLET, realEnv, fakeDeps({ parsed: parsedBal('12345') }));
  check('readBalance-succeeds-against-a-fake-chain', okRead.ok === true && okRead.balance === 12345);

  const zeroRead = await CA.readBalance(WALLET, realEnv, fakeDeps({ parsed: [] }));
  check('readBalance-zero-balance-is-ok-not-an-error', zeroRead.ok === true && zeroRead.balance === 0);

  const rpcErrRead = await CA.readBalance(WALLET, realEnv, fakeDeps({ failParsed: true }));
  check('readBalance-reports-rpc_error-when-the-read-throws', rpcErrRead.ok === false && rpcErrRead.reason === 'rpc_error');

  const providerErrRead = await CA.readBalance(WALLET, realEnv, {
    makeConnection: function () { throw new Error('bad rpc'); }
  });
  check('readBalance-reports-signer_error-when-connection-construction-throws',
    providerErrRead.ok === false && providerErrRead.reason === 'signer_error');

  // Decimals: realEnv pins STRATUM_TOKEN_DECIMALS to '0', so raw and human match.
  const decCheckRead = await CA.readBalance(WALLET, realEnv, fakeDeps({ parsed: parsedBal('777') }));
  check('readBalance-applies-decimals-correctly-at-0-decimals', decCheckRead.balance === 777);

  // At 9 decimals (SPL's own ceiling, still a legal value to explicitly set even
  // though it doesn't match THIS mint), 1_500_000_000 base units read as 1 whole STRATUM.
  const nineEnv = Object.assign({}, realEnv, { STRATUM_TOKEN_DECIMALS: '9' });
  const nineRead = await CA.readBalance(WALLET, nineEnv, fakeDeps({ parsed: parsedBal('1500000000') }));
  check('readBalance-floors-base-units-at-9-decimals', nineRead.ok === true && nineRead.balance === 1);

  // An unset/invalid STRATUM_TOKEN_DECIMALS must fall back to 6 — the real STRATUM mint's
  // own decimals — not a generic SPL ceiling. Getting this wrong silently encodes every
  // real transfer amount 1000x too large against this specific mint.
  const noDecEnv = Object.assign({}, realEnv); delete noDecEnv.STRATUM_TOKEN_DECIMALS;
  const noDecRead = await CA.readBalance(WALLET, noDecEnv, fakeDeps({ parsed: parsedBal('5000000') }));
  check('readBalance-falls-back-to-6-decimals-when-unset', noDecRead.ok === true && noDecRead.balance === 5);

  // -------------------------------------------------------- settleClaim() — queue serializes real sends
  await (async function () {
    let inFlight = 0;
    let sawOverlap = false;
    const order = [];
    function trackingConn(tag) {
      const c = fakeConnection();
      const origBal = c.getAccountInfo;
      const origSend = c.sendRawTransaction;
      c.getAccountInfo = async function (pk) {
        inFlight++;
        if (inFlight > 1) sawOverlap = true;
        await new Promise((r) => setTimeout(r, 15));
        order.push(tag + ':balance');
        inFlight--;
        return origBal(pk);
      };
      c.sendRawTransaction = async function (raw) {
        await new Promise((r) => setTimeout(r, 15));
        order.push(tag + ':send');
        return 'sig-' + tag;
      };
      return c;
    }
    function trackingDeps(tag) {
      return { makeConnection: function () { return trackingConn(tag); } };
    }
    const p1 = CA.settleClaim({ key: 'p1', amountUnits: 1, wallet: WALLET }, realEnv, trackingDeps('first'));
    const p2 = CA.settleClaim({ key: 'p2', amountUnits: 1, wallet: WALLET }, realEnv, trackingDeps('second'));
    const [r1q, r2q] = await Promise.all([p1, p2]);
    check('settleClaim-queue-never-lets-two-sends-overlap', sawOverlap === false);
    check('settleClaim-queue-runs-second-call-strictly-after-the-first-completes', (function () {
      // Every first:* entry must precede every second:* entry (each claim reads the
      // mint + both ATAs, so there are several :balance entries per claim — what
      // matters is the strict partition, not an exact 4-event sequence).
      let lastFirst = -1, firstSecond = -1;
      for (let i = 0; i < order.length; i++) {
        if (order[i].indexOf('first') === 0) lastFirst = i;
        if (order[i].indexOf('second') === 0 && firstSecond === -1) firstSecond = i;
      }
      return lastFirst !== -1 && firstSecond !== -1 && lastFirst < firstSecond;
    })());
    check('settleClaim-queue-both-queued-calls-still-succeed', r1q.ok === true && r2q.ok === true);
    check('settleClaim-queue-both-calls-get-their-own-txHash', r1q.txHash === 'sig-first' && r2q.txHash === 'sig-second');
  })();

  check('canReadMint-true-without-signer', CA.canReadMint(Object.assign({}, realEnv, {
    STRATUM_CLAIM_SIGNER_KEY: undefined, STRATUM_TREASURY_KEY: undefined
  })) === true);
  check('canReadMint-false-when-placeholder', CA.canReadMint(fullEnv) === false);

  const built = await CA.buildPlayerTransfer(WALLET, 10, realEnv, fakeDeps({ playerRaw: 1000n }));
  check('buildPlayerTransfer-returns-unsigned-tx',
    built.ok === true && typeof built.tx === 'string' && built.tx.length > 20 &&
    typeof built.message === 'string' && built.message.length > 20);

  const broke = await CA.buildPlayerTransfer(WALLET, 10, realEnv, fakeDeps({ playerRaw: 1n }));
  check('buildPlayerTransfer-refuses-when-wallet-cannot-cover',
    broke.ok === false && broke.reason === 'insufficient_balance');

  const noPlayer = await CA.buildPlayerTransfer(WALLET, 10, realEnv, fakeDeps());
  check('buildPlayerTransfer-refuses-when-player-has-no-ata',
    noPlayer.ok === false && noPlayer.reason === 'insufficient_balance');

  function parsedMove(playerDrop, treasuryGain) {
    return {
      meta: {
        err: null,
        preTokenBalances: [
          { owner: WALLET, mint: MINT, uiTokenAmount: { amount: String(playerDrop) } },
          { owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { owner: WALLET, mint: MINT, uiTokenAmount: { amount: '0' } },
          { owner: TREASURY, mint: MINT, uiTokenAmount: { amount: String(treasuryGain) } }
        ]
      }
    };
  }
  // realEnv decimals are 0, so 10 whole = 10 raw. 1% tax of 10 floors to 0.
  const verified = await CA.verifyIncomingTransfer('sigTEST123456789012345678901234567890123456', WALLET, 10, realEnv,
    fakeDeps({ parsedTx: parsedMove(10, 10) }));
  check('verifyIncomingTransfer-accepts-matching-move', verified.ok === true);

  const shortPay = await CA.verifyIncomingTransfer('sigTEST123456789012345678901234567890123456', WALLET, 10, realEnv,
    fakeDeps({ parsedTx: parsedMove(4, 4) }));
  check('verifyIncomingTransfer-rejects-wrong-amount',
    shortPay.ok === false && shortPay.reason === 'mismatch');

  const missingTx = await CA.verifyIncomingTransfer('sigTEST123456789012345678901234567890123456', WALLET, 10, realEnv,
    fakeDeps());
  check('verifyIncomingTransfer-not-found-when-absent',
    missingTx.ok === false && missingTx.reason === 'not_found');

  // ---------------------------------------------------------------- purity / hygiene
  const source = require('fs').readFileSync('./src/chain-adapter.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  check('source-never-logs-anything',
    source.indexOf('console.log') === -1);
  check('source-has-no-require-of-other-project-files',
    source.indexOf("require('./") === -1 && source.indexOf('require("./') === -1);
  check('source-requires-solana-web3-the-chain-dependency',
    source.indexOf("@solana/web3.js") >= 0);
  check('source-requires-spl-token-for-transfers',
    source.indexOf("@solana/spl-token") >= 0);
  check('source-has-no-ethers-require',
    source.indexOf("require('ethers')") === -1 && source.indexOf('from \'ethers\'') === -1);

  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
