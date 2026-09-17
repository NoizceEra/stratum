/**
 * chain-adapter.js — the ONE place a real on-chain STRM payout happens.
 *
 * WHY THIS FILE EXISTS
 *   src/rewards.js pays players soft `gold` + hard `token` units into `token_ledger.pending`.
 *   Turning pending into a real chain transfer needs a funded treasury wallet and a signer.
 *   The treasury *address* is public (`token-config.js` / STRATUM_TREASURY_ADDRESS).
 *   The treasury *private key* lives only in a local, gitignored `.env` on the operator's
 *   machine, loaded into the host as STRATUM_CLAIM_SIGNER_KEY (or alias STRATUM_TREASURY_KEY).
 *   This module never logs or returns that key — it's read from env at call time, handed
 *   straight to the signing library, and never cached beyond one settleClaim() call.
 *
 * THE ONE INTENTIONAL DEPENDENCY IN THIS ZERO-DEPENDENCY PROJECT
 *   Every other module here is hand-rolled and dependency-free by design. This file is the
 *   deliberate, scoped exception: it uses `ethers` (see package.json) to sign and broadcast
 *   a real ERC-20 transfer. Hand-rolling secp256k1 ECDSA + RLP encoding + keccak256 for code
 *   that moves real funds is exactly the wrong place to save a dependency — a subtle bug in
 *   from-scratch signing can silently lose money in a way a bug in from-scratch game logic
 *   never can. Nowhere else in src/ or server.js needs (or should ever need) this exception.
 *   This file is also, consequently, Node-only — unlike its siblings it is never loaded as a
 *   plain <script> and has no browser fallback branch worth pretending to support.
 *
 * SAFETY GATES — settleClaim() only ever attempts a real transfer when isConfigured(env)
 * is true, which requires ALL of:
 *   - a well-formed RPC URL, token address, treasury address, and signer key (describe())
 *   - settlementImplemented (true — the signing code below exists and is wired)
 *   - the token address is NOT flagged as the placeholder contract (STRATUM_TOKEN_IS_PLACEHOLDER)
 *   Missing or ambiguous env for that last flag is read as "yes, it's still the placeholder" —
 *   an unset/garbled flag must never accidentally unlock a transfer against the known-wrong
 *   contract (see README.md's Robinhood Chain note for what that contract actually is).
 *   Any other case resolves { ok:false, reason:'not_configured', ... }, same as always, and
 *   the caller (server.js) never decrements pending on that answer — nothing is ever lost.
 *
 * TESTABILITY WITHOUT EVER TOUCHING A REAL CHAIN
 *   settleClaim() takes an optional third `deps` argument — { makeProvider, makeWallet,
 *   makeContract } — used only by test-chain-adapter.js to inject fakes. Production code
 *   (server.js) never passes `deps`, so it always gets the real `ethers` constructors below.
 *   This keeps `npm test` fully offline: no test in this repo ever signs or broadcasts a
 *   real transaction, and none should — a live-chain dry run is the operator's own call to
 *   make, against a real deployed contract, not something this test suite does for them.
 *
 * CONTRACT
 *   - `describe()` / `isConfigured()` are pure, synchronous, given an env snapshot.
 *   - `settleClaim()` always resolves (never rejects/throws) — every failure path returns
 *     a typed { ok:false, reason, detail } instead.
 */
'use strict';
const { ethers } = require('ethers');

function isAddr(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function isHexKey(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
}

/** Minimal ERC-20 surface — nothing else is needed for a treasury -> player payout. */
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

/**
 * Readiness snapshot. Never includes the private key value.
 *
 * Env knobs:
 *   STRATUM_CLAIM_RPC_URL / STRATUM_RPC_URL
 *   STRATUM_CLAIM_TOKEN_ADDR / STRATUM_TOKEN_ADDRESS
 *   STRATUM_TREASURY_ADDRESS
 *   STRATUM_CLAIM_SIGNER_KEY / STRATUM_TREASURY_KEY  (presence only)
 *   STRATUM_TOKEN_IS_PLACEHOLDER  ('0' = real deploy; anything else = still the placeholder)
 *   STRATUM_TOKEN_DECIMALS  (falls back to 18 if missing/out of range)
 */
function describe(env) {
  var e = (env && typeof env === 'object') ? env : {};
  var rpc = e.STRATUM_CLAIM_RPC_URL || e.STRATUM_RPC_URL;
  var token = e.STRATUM_CLAIM_TOKEN_ADDR || e.STRATUM_TOKEN_ADDRESS;
  var treasury = e.STRATUM_TREASURY_ADDRESS;
  var key = e.STRATUM_CLAIM_SIGNER_KEY || e.STRATUM_TREASURY_KEY;
  var hasRpc = typeof rpc === 'string' && /^https?:\/\//i.test(rpc);
  var hasToken = isAddr(token);
  var hasTreasury = isAddr(treasury);
  var hasKey = isHexKey(key);
  return {
    rpcConfigured: hasRpc,
    tokenConfigured: hasToken,
    treasuryConfigured: hasTreasury,
    signerPresent: hasKey,
    // Conservative on purpose: only an explicit '0' counts as "this is the real contract".
    tokenIsPlaceholder: e.STRATUM_TOKEN_IS_PLACEHOLDER !== '0',
    settlementImplemented: true
  };
}

function isConfigured(env) {
  var d = describe(env);
  return d.rpcConfigured && d.tokenConfigured && d.treasuryConfigured &&
    d.signerPresent && d.settlementImplemented && !d.tokenIsPlaceholder;
}

function tokenDecimals(env) {
  var e = (env && typeof env === 'object') ? env : {};
  var dec = Number(e.STRATUM_TOKEN_DECIMALS);
  return (Number.isFinite(dec) && dec >= 0 && dec <= 36) ? (dec | 0) : 18;
}

function defaultDeps() {
  return {
    makeProvider: function (rpcUrl) { return new ethers.JsonRpcProvider(rpcUrl); },
    makeWallet: function (key, provider) { return new ethers.Wallet(key, provider); },
    makeContract: function (address, abi, signer) { return new ethers.Contract(address, abi, signer); }
  };
}

/**
 * Attempt to settle one claim on-chain. Always resolves (never rejects).
 * Not configured (still the common case today — see the placeholder-contract note in
 * README.md) -> { ok:false, reason:'not_configured', ... }; pending balance must stay put.
 * Configured -> a real ERC-20 transfer(treasury -> req.wallet) of req.amountUnits STRM.
 *
 * `deps` is test-only dependency injection (see the file header); production callers pass
 * nothing and get the real `ethers`-backed implementation.
 */
async function settleClaim(req, env, deps) {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, reason: 'bad_request', detail: 'malformed claim request' };
    }
    if (!isAddr(req.wallet)) {
      return { ok: false, reason: 'bad_request', detail: 'claim wallet invalid' };
    }
    var amount = req.amountUnits;
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
      return { ok: false, reason: 'bad_request', detail: 'claim amount invalid' };
    }
    var d = describe(env);
    if (!isConfigured(env)) {
      var missing = [];
      if (!d.rpcConfigured) missing.push('rpc');
      if (!d.tokenConfigured) missing.push('token');
      if (!d.treasuryConfigured) missing.push('treasury address');
      if (!d.signerPresent) missing.push('signer key');
      if (d.tokenIsPlaceholder) missing.push('a real (non-placeholder) token contract');
      return {
        ok: false,
        reason: 'not_configured',
        detail: 'on-chain settlement not live yet (missing: ' + missing.join(', ') +
          ') — claim is recorded; pending balance unchanged'
      };
    }

    var e = env;
    var rpc = e.STRATUM_CLAIM_RPC_URL || e.STRATUM_RPC_URL;
    var tokenAddr = e.STRATUM_CLAIM_TOKEN_ADDR || e.STRATUM_TOKEN_ADDRESS;
    var signerKey = e.STRATUM_CLAIM_SIGNER_KEY || e.STRATUM_TREASURY_KEY;
    var dec = tokenDecimals(env);
    var fns = Object.assign(defaultDeps(), deps || {});

    var provider, wallet, contract;
    try {
      provider = fns.makeProvider(rpc);
      wallet = fns.makeWallet(signerKey, provider);
      contract = fns.makeContract(tokenAddr, ERC20_ABI, wallet);
    } catch (eSigner) {
      return { ok: false, reason: 'signer_error', detail: eSigner && eSigner.message };
    }

    var amountUnits;
    try {
      amountUnits = ethers.parseUnits(String(amount), dec);
    } catch (eParse) {
      return { ok: false, reason: 'bad_request', detail: 'could not encode claim amount for ' + dec + ' decimals' };
    }

    // A pre-flight balance read avoids paying gas for a guaranteed-to-revert transfer,
    // and gives the player a clearer reason than a generic send failure.
    try {
      var treasuryAddr = await wallet.getAddress();
      var bal = await contract.balanceOf(treasuryAddr);
      if (bal < amountUnits) {
        return { ok: false, reason: 'insufficient_treasury_balance', detail: 'treasury holds less STRM than this claim needs' };
      }
    } catch (eBal) {
      return { ok: false, reason: 'rpc_error', detail: 'could not read treasury balance: ' + (eBal && eBal.message) };
    }

    try {
      var tx = await contract.transfer(req.wallet, amountUnits);
      var receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        return { ok: false, reason: 'tx_failed', detail: 'transaction did not confirm successfully', txHash: tx.hash };
      }
      return { ok: true, txHash: tx.hash };
    } catch (eSend) {
      return { ok: false, reason: 'send_failed', detail: eSend && eSend.message };
    }
  } catch (e) {
    return { ok: false, reason: 'internal_error', detail: e && e.message };
  }
}

module.exports = {
  describe: describe,
  isConfigured: isConfigured,
  settleClaim: settleClaim
};
