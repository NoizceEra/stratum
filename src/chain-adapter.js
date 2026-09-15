/**
 * chain-adapter.js — the ONE place a real on-chain STRM payout would happen. It does not
 * happen yet, on purpose.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOTHING BY DEFAULT
 *   src/rewards.js pays players in two currencies: soft `gold` (an ordinary inventory
 *   resource, spent and earned entirely on this server) and hard `token` units, which
 *   accrue in the `token_ledger` table as a `pending` balance — an IOU, not a payout.
 *   Turning that IOU into a real on-chain transfer requires a wallet with either mint
 *   authority or a funded balance, holding a real private key, reachable from this
 *   server. That is real custody risk, and STRATUM has none of that today:
 *     - src/token-config.js's default STRM contract is explicitly `placeholder: true`.
 *     - public/wallet.js is READ-ONLY (balanceOf only — it never signs or sends).
 *     - Nothing in this codebase has ever held, generated, or transmitted a private key.
 *   This module is the seam where that changes, LATER, deliberately: `isConfigured()`
 *   is false until an operator sets real signer env vars on their own infrastructure
 *   (never in chat, never committed to this repo), and `settleClaim()` refuses to do
 *   anything at all until it is. Every claim still gets a full, honest audit trail
 *   (server.js's claim_requests table) either way — "not configured yet" is a normal,
 *   expected answer, not a failure to be hidden.
 *
 * WHAT REAL SETTLEMENT WOULD ACTUALLY REQUIRE (deliberately NOT built here)
 *   Signing and broadcasting a real Ethereum-style transaction needs correct RLP
 *   encoding, secp256k1 ECDSA signing with a recovery id, and keccak256 — real
 *   cryptographic primitives that are easy to get subtly wrong and expensive to get
 *   wrong with real funds on the line. Hand-rolling them here, under this project's
 *   zero-npm-dependency rule, purely so an unconfigured stub can claim to "work," would
 *   be worse than not doing it: either genuinely risky handwritten crypto, or a fake
 *   implementation dressed up to look real. Real settlement should come from a small,
 *   well-reviewed signer (a vetted library, or a separate signer service called over the
 *   network) added deliberately when there is an actual contract and actual funds behind
 *   it — not smuggled in as a side effect of building the claim UI.
 *
 * CONTRACT
 *   - Dependency-free. No require() of anything outside Node's own `process`/`crypto`
 *     built-ins (both untouched today — this file does not even read them yet).
 *   - Dual-target UMD, same as every other src/ module, though in practice only the
 *     server ever loads this one (there is no client-side signing here or anywhere else).
 *   - `isConfigured()` and `describe()` are pure given an env snapshot. `settleClaim()`
 *     is async because a real implementation necessarily is (network calls to a chain);
 *     today it resolves immediately with a `not_configured` result and touches nothing.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.ChainAdapter = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /**
   * Read-only snapshot of what a real settler would need. `signerConfigured` is true only
   * when every one of these is present and shaped correctly:
   *   STRATUM_CLAIM_RPC_URL      an http(s) RPC endpoint for the target chain
   *   STRATUM_CLAIM_TOKEN_ADDR   the ERC-20 contract to pay out from (0x + 40 hex)
   *   STRATUM_CLAIM_SIGNER_KEY   presence checked ONLY (never read into this return value,
   *                              never logged) — real signing is not implemented, so this
   *                              flag can only ever describe readiness, never grant it.
   * A caller passes `env` explicitly (mirrors token-config.js's `withEnv(process.env)`
   * pattern) so this stays testable without touching real process.env.
   */
  function describe(env) {
    var e = (env && typeof env === 'object') ? env : {};
    var hasRpc = typeof e.STRATUM_CLAIM_RPC_URL === 'string' && /^https?:\/\//i.test(e.STRATUM_CLAIM_RPC_URL);
    var hasToken = typeof e.STRATUM_CLAIM_TOKEN_ADDR === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.STRATUM_CLAIM_TOKEN_ADDR);
    var hasKey = typeof e.STRATUM_CLAIM_SIGNER_KEY === 'string' && e.STRATUM_CLAIM_SIGNER_KEY.length > 0;
    return {
      rpcConfigured: hasRpc,
      tokenConfigured: hasToken,
      signerPresent: hasKey,
      // Real settlement is not implemented at all yet (see file header) — this is never
      // true today no matter what env is passed. It exists as the single flag a future
      // settleClaim() would flip once a real signer is actually wired in, so callers
      // (server.js) never need to change how they read "is this feature live."
      settlementImplemented: false
    };
  }

  /** True only when every piece a real settle would need is present. Always false today
   *  (settlementImplemented never flips) — see describe(). */
  function isConfigured(env) {
    var d = describe(env);
    return d.rpcConfigured && d.tokenConfigured && d.signerPresent && d.settlementImplemented;
  }

  /**
   * Attempt to settle one claim on-chain. Always resolves (never rejects) with:
   *   { ok:false, reason:'not_configured', detail }   today, always — nothing was touched.
   * A real implementation would additionally resolve:
   *   { ok:true, txHash, settledUnits }                on a confirmed on-chain transfer.
   *   { ok:false, reason:'chain_error', detail }        on a real, later failure.
   * Never throws. Callers (server.js) must treat `ok:false` as "still pending, try later"
   * and never as "this claim was denied" — the player is still owed the tokens either way.
   */
  async function settleClaim(req, env) {
    try {
      if (!req || typeof req !== 'object') {
        return { ok: false, reason: 'bad_request', detail: 'malformed claim request' };
      }
      if (!isConfigured(env)) {
        return {
          ok: false, reason: 'not_configured',
          detail: 'on-chain settlement is not wired up yet — this claim is recorded and will settle once it is'
        };
      }
      // Unreachable today: isConfigured() can never return true (settlementImplemented is
      // hardcoded false above), so real settlement code has nothing to be added ONTO by
      // accident. When it's genuinely time to build this, this branch is the whole diff.
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
