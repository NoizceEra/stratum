/**
 * chain-adapter.js — the ONE place a real on-chain STRM payout would happen. It does not
 * happen yet, on purpose — but readiness is now measured against the real treasury wallet.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOTHING BY DEFAULT
 *   src/rewards.js pays players soft `gold` + hard `token` units into `token_ledger.pending`.
 *   Turning pending into a chain transfer needs a funded treasury wallet and a signer.
 *   The treasury *address* is public (`token-config.js` / STRATUM_TREASURY_ADDRESS).
 *   The treasury *private key* lives only in a local, gitignored `.env` on the operator's
 *   machine, loaded into the host as STRATUM_CLAIM_SIGNER_KEY (or alias STRATUM_TREASURY_KEY).
 *   This module never logs or returns that key.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require of project files. Env is passed in explicitly.
 *   - `describe()` / `isConfigured()` are pure given an env snapshot.
 *   - `settleClaim()` always resolves; today always `not_configured` until
 *     `settlementImplemented` is flipped and a real signer is wired.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.ChainAdapter = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isAddr(s) {
    return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
  }

  function isHexKey(s) {
    return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
  }

  /**
   * Readiness snapshot. Never includes the private key value.
   *
   * Env knobs:
   *   STRATUM_CLAIM_RPC_URL / STRATUM_RPC_URL
   *   STRATUM_CLAIM_TOKEN_ADDR / STRATUM_TOKEN_ADDRESS
   *   STRATUM_TREASURY_ADDRESS
   *   STRATUM_CLAIM_SIGNER_KEY / STRATUM_TREASURY_KEY  (presence only)
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
      // Flip only when a reviewed signer implementation is actually wired below.
      settlementImplemented: false
    };
  }

  function isConfigured(env) {
    var d = describe(env);
    return d.rpcConfigured && d.tokenConfigured && d.treasuryConfigured &&
      d.signerPresent && d.settlementImplemented;
  }

  /**
   * Attempt to settle one claim on-chain. Always resolves (never rejects).
   * Today: always { ok:false, reason:'not_configured' } — pending balance must stay put.
   */
  async function settleClaim(req, env) {
    try {
      if (!req || typeof req !== 'object') {
        return { ok: false, reason: 'bad_request', detail: 'malformed claim request' };
      }
      if (!isAddr(req.wallet)) {
        return { ok: false, reason: 'bad_request', detail: 'claim wallet invalid' };
      }
      var amount = req.amountUnits;
      if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
        return { ok: false, reason: 'bad_request', detail: 'claim amount invalid' };
      }
      var d = describe(env);
      if (!isConfigured(env)) {
        var missing = [];
        if (!d.rpcConfigured) missing.push('rpc');
        if (!d.tokenConfigured) missing.push('token');
        if (!d.treasuryConfigured) missing.push('treasury address');
        if (!d.signerPresent) missing.push('signer key');
        if (!d.settlementImplemented) missing.push('settlement implementation');
        return {
          ok: false,
          reason: 'not_configured',
          detail: 'on-chain settlement not live yet (missing: ' + missing.join(', ') +
            ') — claim is recorded; pending balance unchanged'
        };
      }
      return { ok: false, reason: 'not_configured', detail: 'unreachable' };
    } catch (e) {
      return { ok: false, reason: 'internal_error', detail: e && e.message };
    }
  }

  return {
    describe: describe,
    isConfigured: isConfigured,
    settleClaim: settleClaim
  };
});
