/**
 * token-config.js — Solana commerce token for STRATUM.
 *
 * STRATUM (on-chain name "Planet Stratum", on-chain symbol "STRATUM") lives on Solana
 * mainnet-beta as a Token-2022 mint with a transfer-fee extension (1% per the mint's
 * own on-chain config, enforced by the token program on every transfer — not something
 * this codebase adds or can remove), 6 decimals. Minted 2026; mint authority is null
 * (fixed supply, nobody can mint more), freeze authority is null (no account can be
 * frozen). See src/chain-adapter.js for the Token-2022-aware settlement code this
 * mint's program requires (the legacy Token program's instructions do not work against
 * it — see that file's header).
 *
 * The mint *address* and the treasury *address* are both public and safe to ship as
 * real defaults below (same as any public wallet/contract address). The treasury
 * *secret key* lives only in a local, gitignored `.env` (STRATUM_CLAIM_SIGNER_KEY,
 * base58 or JSON-array form) on the operator's machine — never in this file, and
 * setting the mint alone does NOT unlock real settlement; chain-adapter.js's
 * isConfigured() still requires that signer key before a single unit ever moves.
 *
 * Override at runtime (server only):
 *   STRATUM_TOKEN_MINT (aliases: STRATUM_TOKEN_ADDRESS, STRATUM_CLAIM_TOKEN_ADDR) /
 *   STRATUM_CLUSTER / STRATUM_SOLANA_RPC (alias: STRATUM_RPC_URL) /
 *   STRATUM_TOKEN_SYMBOL / STRATUM_TOKEN_DECIMALS / STRATUM_TREASURY_ADDRESS
 *
 * CONTRACT
 *   - Dependency-free UMD. No require of other project files, no DOM, no I/O
 *     at top level. Server may call `withEnv(process.env)` to apply overrides.
 *   - Pure + deterministic; never mutates arguments; returns fresh objects.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.TokenConfig = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /** Solana addresses are base58-encoded 32-byte ed25519 public keys. */
  function isAddr(s) {
    if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
    for (var i = 0; i < s.length; i++) {
      if (B58.indexOf(s.charAt(i)) === -1) return false;
    }
    return true;
  }

  /**
   * Defaults — Solana mainnet-beta + placeholder mint sentinel + treasury
   * address. Treasury secret key is NOT here (lives only in a local .env).
   */
  var DEFAULTS = deepFreeze({
    cluster: 'mainnet-beta',
    chainName: 'Solana',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    explorerTokenUrl: 'https://explorer.solana.com/address/',
    explorerAddressUrl: 'https://explorer.solana.com/address/',
    nativeCurrency: deepFreeze({ name: 'SOL', symbol: 'SOL', decimals: 9 }),
    /** SPL mint for STRATUM — Token-2022, 6 decimals, verified on mainnet-beta 2026-09-24. */
    tokenMint: 'EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU',
    /** Alias kept so existing client/server code reading `tokenAddress` keeps working. */
    tokenAddress: 'EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU',
    /** On-chain payout wallet (public). Fresh Solana keypair generated 2026-09-22. */
    treasuryAddress: 'AYMwwmPxucSXDoc3Qx7prVnH5rP3XpgBDJVENed4A9mo',
    /** Display ticker — matches the mint's own on-chain Token-2022 metadata symbol
     *  exactly ("STRATUM"), verified 2026-09-24. Was "STRATUM" as a distinct shorthand
     *  before the real mint existed; corrected to match the actual contract once it
     *  did, per the project owner's explicit call (a shorthand that doesn't match the
     *  real ticker risks confusing anyone verifying the token against the contract). */
    symbol: 'STRATUM',
    name: 'STRATUM',
    decimals: 6,
    placeholder: false
  });

  function copy(cfg) {
    return {
      cluster: cfg.cluster,
      chainName: cfg.chainName,
      rpcUrl: cfg.rpcUrl,
      explorerUrl: cfg.explorerUrl,
      explorerTokenUrl: cfg.explorerTokenUrl,
      explorerAddressUrl: cfg.explorerAddressUrl || DEFAULTS.explorerAddressUrl,
      nativeCurrency: {
        name: cfg.nativeCurrency.name,
        symbol: cfg.nativeCurrency.symbol,
        decimals: cfg.nativeCurrency.decimals
      },
      tokenMint: cfg.tokenMint,
      tokenAddress: cfg.tokenAddress,
      treasuryAddress: cfg.treasuryAddress,
      symbol: cfg.symbol,
      name: cfg.name,
      decimals: cfg.decimals,
      placeholder: !!cfg.placeholder
    };
  }

  /** Public snapshot safe to send to clients (no secrets — addresses only). */
  function publicConfig(cfg) {
    var c = cfg || DEFAULTS;
    return {
      cluster: c.cluster,
      chainName: c.chainName,
      rpcUrl: c.rpcUrl,
      explorerUrl: c.explorerUrl,
      explorerTokenUrl: c.explorerTokenUrl,
      explorerAddressUrl: c.explorerAddressUrl || DEFAULTS.explorerAddressUrl,
      nativeCurrency: {
        name: c.nativeCurrency.name,
        symbol: c.nativeCurrency.symbol,
        decimals: c.nativeCurrency.decimals
      },
      tokenMint: c.tokenMint,
      tokenAddress: c.tokenAddress,
      treasuryAddress: c.treasuryAddress,
      symbol: c.symbol,
      name: c.name,
      decimals: c.decimals,
      placeholder: !!c.placeholder
    };
  }

  /**
   * Apply process.env overrides. Only used on the Node server.
   * Unknown / malformed values are ignored so a typo cannot blank the mint.
   */
  function withEnv(env) {
    var out = copy(DEFAULTS);
    if (!env || typeof env !== 'object') return out;
    var mint = env.STRATUM_TOKEN_MINT || env.STRATUM_TOKEN_ADDRESS || env.STRATUM_CLAIM_TOKEN_ADDR;
    if (isAddr(mint)) {
      out.tokenMint = mint;
      out.tokenAddress = mint;
      out.placeholder = false;
    }
    if (isAddr(env.STRATUM_TREASURY_ADDRESS)) {
      out.treasuryAddress = env.STRATUM_TREASURY_ADDRESS;
    }
    if (typeof env.STRATUM_CLUSTER === 'string' &&
        (env.STRATUM_CLUSTER === 'mainnet-beta' || env.STRATUM_CLUSTER === 'devnet' ||
         env.STRATUM_CLUSTER === 'testnet' || env.STRATUM_CLUSTER === 'localhost')) {
      out.cluster = env.STRATUM_CLUSTER;
    }
    var rpc = env.STRATUM_SOLANA_RPC || env.STRATUM_RPC_URL;
    if (typeof rpc === 'string' && /^https?:\/\//i.test(rpc)) {
      out.rpcUrl = rpc;
    }
    if (typeof env.STRATUM_TOKEN_SYMBOL === 'string' && env.STRATUM_TOKEN_SYMBOL.length && env.STRATUM_TOKEN_SYMBOL.length <= 12) {
      out.symbol = env.STRATUM_TOKEN_SYMBOL;
    }
    if (typeof env.STRATUM_TOKEN_NAME === 'string' && env.STRATUM_TOKEN_NAME.length && env.STRATUM_TOKEN_NAME.length <= 32) {
      out.name = env.STRATUM_TOKEN_NAME;
    }
    var dec = Number(env.STRATUM_TOKEN_DECIMALS);
    if (Number.isFinite(dec) && dec >= 0 && dec <= 9) out.decimals = dec | 0;
    if (env.STRATUM_TOKEN_PLACEHOLDER === '0' || env.STRATUM_TOKEN_PLACEHOLDER === 'false') out.placeholder = false;
    if (env.STRATUM_TOKEN_PLACEHOLDER === '1' || env.STRATUM_TOKEN_PLACEHOLDER === 'true') out.placeholder = true;
    // A real mint is the switch that turns settlement on. .env.example ships
    // STRATUM_TOKEN_PLACEHOLDER=true next to the sentinel; once the operator
    // replaces the mint, that leftover flag must not put the gate back.
    if (isAddr(mint)) out.placeholder = false;
    return out;
  }

  function explorerTokenLink(cfg) {
    var c = cfg || DEFAULTS;
    return c.explorerTokenUrl + c.tokenMint;
  }

  function explorerTreasuryLink(cfg) {
    var c = cfg || DEFAULTS;
    var base = c.explorerAddressUrl || DEFAULTS.explorerAddressUrl;
    return base + c.treasuryAddress;
  }

  return {
    DEFAULTS: DEFAULTS,
    copy: copy,
    publicConfig: publicConfig,
    withEnv: withEnv,
    isAddr: isAddr,
    explorerTokenLink: explorerTokenLink,
    explorerTreasuryLink: explorerTreasuryLink
  };
});
