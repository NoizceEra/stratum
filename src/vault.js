/**
 * vault.js — the STRATUM vault: an in-game staking pool for GLDX yield.
 *
 * WHY THIS FILE EXISTS
 *   Tithes reward loyalty with a yield boost; the vault rewards depth. Deposit
 *   pending STRATUM, earn a pro-rata share of a fixed weekly GLDX emission while
 *   it sits, withdraw anytime. Entry and exit both tax the treasury (1% in,
 *   2.5% out), so the pool deepens the treasury on the way in AND on the way
 *   out. The emission is a fixed pool per week credited to gldxPending — never
 *   minted on-chain; on-chain GLDX payout stays capped by the treasury's real
 *   balance at claim-gldx time (see fundGldxClaims).
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Never throws, never mutates.
 *   - Integer math throughout. Amounts are whole STRATUM; GLDX shares are raw units.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Vault = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function isPosInt(n) { return isInt(n) && n > 0; }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  /** Minimum deposit, whole STRATUM. Below this the 1% entry fee rounds to dust. */
  var MIN_DEPOSIT = 100;
  /** Entry fee, basis points of the deposit -> treasury. */
  var DEPOSIT_FEE_BPS = 100;
  /** Exit fee, basis points of the withdrawal -> treasury. */
  var WITHDRAW_FEE_BPS = 250;
  var FEE_DENOM = 10000;
  /** Weekly GLDX emission pool, raw units. Env-tunable server-side. */
  var WEEKLY_GLDX = 25000;
  var WEEK_MS = 7 * 24 * 3600 * 1000;

  /**
   * Validate a deposit of `amount` from `pending`. Returns
   * { ok, gross, fee, net, error }. Fee is floored; net = gross - fee.
   */
  function validateDeposit(amount, pending) {
    if (!isPosInt(amount)) return { ok: false, gross: 0, fee: 0, net: 0, error: 'bad amount' };
    if (amount < MIN_DEPOSIT) return { ok: false, gross: 0, fee: 0, net: 0, error: 'minimum deposit ' + MIN_DEPOSIT };
    if (!isInt(pending) || pending < amount) return { ok: false, gross: 0, fee: 0, net: 0, error: 'cannot afford' };
    var fee = Math.floor((amount * DEPOSIT_FEE_BPS) / FEE_DENOM);
    return { ok: true, gross: amount, fee: fee, net: amount - fee, error: null };
  }

  /**
   * Validate a withdrawal of `amount` from `balance`. Returns
   * { ok, gross, fee, net, error }. Withdrawing everything is allowed.
   */
  function validateWithdraw(amount, balance) {
    if (!isPosInt(amount)) return { ok: false, gross: 0, fee: 0, net: 0, error: 'bad amount' };
    if (!isInt(balance) || balance <= 0) return { ok: false, gross: 0, fee: 0, net: 0, error: 'nothing deposited' };
    if (amount > balance) return { ok: false, gross: 0, fee: 0, net: 0, error: 'cannot afford' };
    var fee = Math.floor((amount * WITHDRAW_FEE_BPS) / FEE_DENOM);
    var net = amount - fee;
    if (net < 1) return { ok: false, gross: 0, fee: 0, net: 0, error: 'fee consumes withdrawal' };
    return { ok: true, gross: amount, fee: fee, net: net, error: null };
  }

  /**
   * Pro-rata GLDX shares for one weekly emission. `rows` is [{ key, balance }],
   * `pool` raw GLDX units. Returns [{ key, share }] with shares floored; dust
   * (pool - sum) goes to the largest depositor so the full pool is always
   * assigned. Never throws; empty/zero input yields [].
   */
  function emissionShares(rows, pool) {
    try {
      if (!Array.isArray(rows) || !isPosInt(pool)) return [];
      var total = 0, i;
      for (i = 0; i < rows.length; i++) {
        var b = rows[i] && rows[i].balance;
        if (isPosInt(b)) total += b;
      }
      if (total <= 0) return [];
      var out = [], given = 0;
      for (i = 0; i < rows.length; i++) {
        var bb = (rows[i] && rows[i].balance) || 0;
        var share = isPosInt(bb) ? Math.floor((pool * bb) / total) : 0;
        out.push({ key: rows[i].key, share: share });
        given += share;
      }
      var dust = pool - given;
      if (dust > 0) {
        var best = -1;
        for (i = 0; i < rows.length; i++) {
          var b2 = (rows[i] && rows[i].balance) || 0;
          if (b2 > 0 && (best < 0 || b2 > ((rows[best] && rows[best].balance) || 0))) best = i;
        }
        if (best >= 0) out[best].share += dust;
      }
      return out;
    } catch (e) { return []; }
  }

  return {
    MIN_DEPOSIT: MIN_DEPOSIT,
    DEPOSIT_FEE_BPS: DEPOSIT_FEE_BPS,
    WITHDRAW_FEE_BPS: WITHDRAW_FEE_BPS,
    FEE_DENOM: FEE_DENOM,
    WEEKLY_GLDX: WEEKLY_GLDX,
    WEEK_MS: WEEK_MS,
    validateDeposit: validateDeposit,
    validateWithdraw: validateWithdraw,
    emissionShares: emissionShares
  };
});
