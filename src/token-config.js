/**
 * token-config.js — Robinhood Chain commerce token for STRATUM.
 *
 * ✅ CHAIN VERIFIED 2026-09-17: chainId 4663, rpcUrl below both confirmed live against
 * the real RPC (eth_chainId -> 0x1237 = 4663; eth_blockNumber advancing). This really is
 * a reachable EVM chain with the chain ID this file claims.
 *
 * ⚠️ TOKEN ADDRESS IS STILL WRONG: `tokenAddress` below is a real, already-deployed
 * contract on that chain — but it's "FLIR Technologies" (symbol FLIR), an unrelated
 * token with its own real circulating supply, NOT STRM. `chain-adapter.js`'s
 * settlementImplemented is real (it signs and broadcasts via `ethers`), but its
 * isConfigured() gate refuses to run while `placeholder` is true here — see
 * contracts/StratumToken.sol + contracts/README.md for deploying the real token, and
 * README.md's Commerce section for the full note.
 *
 * PLACEHOLDER: the token contract address below will be replaced with the official
 * deploy (see contracts/). The treasury *address* is public and safe to ship; the
 * treasury *private key* lives only in a local, gitignored `.env`
 * (STRATUM_CLAIM_SIGNER_KEY) on the operator's machine — never in this file.
 *
 * Override at runtime (server only):
 *   STRATUM_TOKEN_ADDRESS / STRATUM_CHAIN_ID / STRATUM_RPC_URL /
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

  function isAddr(s) {
    return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
  }

  /**
   * Defaults — Robinhood Chain mainnet (chain reachability verified — see file header)
   * + temporary commerce CA (wrong on purpose today — also see file header) + treasury
   * address. Treasury private key is NOT here (lives only in a local .env).
   */
  var DEFAULTS = deepFreeze({
    chainId: 4663,
    chainName: 'Robinhood Chain',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    explorerTokenUrl: 'https://robinhoodchain.blockscout.com/token/',
    explorerAddressUrl: 'https://robinhoodchain.blockscout.com/address/',
    nativeCurrency: deepFreeze({ name: 'ETH', symbol: 'ETH', decimals: 18 }),
    tokenAddress: '0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7',
    /** On-chain payout wallet (public). Generated 2026-09-15. */
    treasuryAddress: '0xE8896562619Fe0276d65952b51dcC11C17b8C144',
    symbol: 'STRM',
    name: 'STRATUM',
    decimals: 18,
    placeholder: true
  });

  function copy(cfg) {
    return {
      chainId: cfg.chainId,
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
      tokenAddress: cfg.tokenAddress,
      treasuryAddress: cfg.treasuryAddress,
      symbol: cfg.symbol,
      name: cfg.name,
      decimals: cfg.decimals,
      placeholder: !!cfg.placeholder
    };
  }

  /** Public snapshot safe to send to clients (no secrets — address only). */
  function publicConfig(cfg) {
    var c = cfg || DEFAULTS;
    return {
      chainId: c.chainId,
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
   * Unknown / malformed values are ignored so a typo cannot blank the CA.
   */
  function withEnv(env) {
    var out = copy(DEFAULTS);
    if (!env || typeof env !== 'object') return out;
    if (isAddr(env.STRATUM_TOKEN_ADDRESS)) {
      out.tokenAddress = env.STRATUM_TOKEN_ADDRESS;
      out.placeholder = false;
    }
    if (isAddr(env.STRATUM_TREASURY_ADDRESS)) {
      out.treasuryAddress = env.STRATUM_TREASURY_ADDRESS;
    }
    var cid = Number(env.STRATUM_CHAIN_ID);
    if (Number.isFinite(cid) && cid > 0) out.chainId = cid | 0;
    if (typeof env.STRATUM_RPC_URL === 'string' && /^https?:\/\//i.test(env.STRATUM_RPC_URL)) {
      out.rpcUrl = env.STRATUM_RPC_URL;
    }
    if (typeof env.STRATUM_TOKEN_SYMBOL === 'string' && env.STRATUM_TOKEN_SYMBOL.length && env.STRATUM_TOKEN_SYMBOL.length <= 12) {
      out.symbol = env.STRATUM_TOKEN_SYMBOL;
    }
    if (typeof env.STRATUM_TOKEN_NAME === 'string' && env.STRATUM_TOKEN_NAME.length && env.STRATUM_TOKEN_NAME.length <= 32) {
      out.name = env.STRATUM_TOKEN_NAME;
    }
    var dec = Number(env.STRATUM_TOKEN_DECIMALS);
    if (Number.isFinite(dec) && dec >= 0 && dec <= 36) out.decimals = dec | 0;
    if (env.STRATUM_TOKEN_PLACEHOLDER === '0' || env.STRATUM_TOKEN_PLACEHOLDER === 'false') out.placeholder = false;
    if (env.STRATUM_TOKEN_PLACEHOLDER === '1' || env.STRATUM_TOKEN_PLACEHOLDER === 'true') out.placeholder = true;
    return out;
  }

  function explorerTokenLink(cfg) {
    var c = cfg || DEFAULTS;
    return c.explorerTokenUrl + c.tokenAddress;
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
