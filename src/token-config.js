/**
 * token-config.js — Robinhood Chain commerce token for STRATUM.
 *
 * PLACEHOLDER: the contract address below will be replaced with the official
 * deploy. Override at runtime with STRATUM_TOKEN_ADDRESS / STRATUM_CHAIN_ID /
 * STRATUM_RPC_URL / STRATUM_TOKEN_SYMBOL / STRATUM_TOKEN_DECIMALS (server only).
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

  /** Defaults — Robinhood Chain mainnet + temporary commerce CA. */
  var DEFAULTS = deepFreeze({
    chainId: 4663,
    chainName: 'Robinhood Chain',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    explorerTokenUrl: 'https://robinhoodchain.blockscout.com/token/',
    nativeCurrency: deepFreeze({ name: 'ETH', symbol: 'ETH', decimals: 18 }),
    tokenAddress: '0x0d0f4c7e2373f2bd67caa2a83d466df2225e4ca7',
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
      nativeCurrency: {
        name: cfg.nativeCurrency.name,
        symbol: cfg.nativeCurrency.symbol,
        decimals: cfg.nativeCurrency.decimals
      },
      tokenAddress: cfg.tokenAddress,
      symbol: cfg.symbol,
      name: cfg.name,
      decimals: cfg.decimals,
      placeholder: !!cfg.placeholder
    };
  }

  /** Public snapshot safe to send to clients (no secrets). */
  function publicConfig(cfg) {
    var c = cfg || DEFAULTS;
    return {
      chainId: c.chainId,
      chainName: c.chainName,
      rpcUrl: c.rpcUrl,
      explorerUrl: c.explorerUrl,
      explorerTokenUrl: c.explorerTokenUrl,
      nativeCurrency: {
        name: c.nativeCurrency.name,
        symbol: c.nativeCurrency.symbol,
        decimals: c.nativeCurrency.decimals
      },
      tokenAddress: c.tokenAddress,
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

  return {
    DEFAULTS: DEFAULTS,
    copy: copy,
    publicConfig: publicConfig,
    withEnv: withEnv,
    isAddr: isAddr,
    explorerTokenLink: explorerTokenLink
  };
});
