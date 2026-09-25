/**
 * gldx-yield.js — play earns a GLDX claim; holding STRATUM makes that claim larger.
 *
 * StonkFun already pays GLDX to wallets that hold STRATUM, out of the 1% transfer
 * tax. This module is the game's own stream, and it never mints GLDX. A claim is
 * an integer number of raw units (GLDX has 8 decimals). Payout later is capped
 * by whatever GLDX the treasury actually holds.
 *
 * Sinks stay in src/token-sink.js (80% burned, 20% treasury). Half of that
 * treasury slice is the amount the server may swap into GLDX to fund claims.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.GldxYield = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var DECIMALS = 8;
  var SCALE = 100000000;
  /** xStock GLDX, the quote asset STRATUM trades against on StonkFun. */
  var GLDX_MINT = 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re';
  /** Address with no known signer. A transfer here is a real supply burn, and
   *  because it is a transfer the 1% STRATUM tax is withheld for holder rewards. */
  var INCINERATOR = '1nc1nerator11111111111111111111111111111111';
  /** Don't swap dust. Whole STRATUM units. */
  var MIN_SWAP = 25;

  var RATES = { harvest: 100, craft: 150, kill: 150 };

  function isNonNegInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= 0; }

  function creditFor(action, multiplier, ctx) {
    var base = RATES[action] || 0;
    if (action === 'kill' && ctx && typeof ctx.xp === 'number' && isFinite(ctx.xp) && ctx.xp > 0) {
      base += Math.floor(ctx.xp);
    }
    if (base <= 0) return 0;
    var m = (typeof multiplier === 'number' && isFinite(multiplier) && multiplier > 1) ? multiplier : 1;
    var boosted = Math.floor(base * m);
    return boosted > base ? boosted : base;
  }

  /** Half of the sink's treasury slice, in whole STRATUM. The rest stays put. */
  function earmarkOf(treasuryPart) {
    if (!isNonNegInt(treasuryPart)) return 0;
    return Math.floor(treasuryPart / 2);
  }

  /**
   * Move pending GLDX claims into payable, never more than `treasuryRaw` minus
   * what is already payable. Pro-rata by pending weight. Dust goes to the
   * largest remaining claim so the moved total matches the funded amount.
   */
  function allocate(rows, treasuryRaw) {
    if (!Array.isArray(rows) || !isNonNegInt(treasuryRaw)) return { rows: [], moved: 0 };
    var reserved = 0;
    var totalPending = 0;
    var copy = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      var pending = isNonNegInt(r.pending) ? r.pending : 0;
      var payable = isNonNegInt(r.payable) ? r.payable : 0;
      reserved += payable;
      totalPending += pending;
      copy.push({ key: r.key, pending: pending, payable: payable });
    }
    var free = treasuryRaw - reserved;
    if (free <= 0 || totalPending <= 0) return { rows: copy, moved: 0 };
    var move = free < totalPending ? free : totalPending;
    var given = 0;
    for (var j = 0; j < copy.length; j++) {
      if (copy[j].pending <= 0) continue;
      var share = Math.floor(move * copy[j].pending / totalPending);
      if (share > copy[j].pending) share = copy[j].pending;
      copy[j].pending -= share;
      copy[j].payable += share;
      given += share;
    }
    var dust = move - given;
    var guard = 0;
    while (dust > 0 && guard < copy.length + 2) {
      guard++;
      var best = -1;
      for (var k = 0; k < copy.length; k++) {
        if (copy[k].pending <= 0) continue;
        if (best < 0 || copy[k].pending > copy[best].pending) best = k;
      }
      if (best < 0) break;
      var take = dust < copy[best].pending ? dust : copy[best].pending;
      copy[best].pending -= take;
      copy[best].payable += take;
      dust -= take;
      given += take;
    }
    return { rows: copy, moved: given };
  }

  function format(raw) {
    if (!isNonNegInt(raw)) return '0';
    var whole = Math.floor(raw / SCALE);
    var frac = String(raw % SCALE).padStart(DECIMALS, '0').replace(/0+$/, '');
    return frac ? (whole + '.' + frac) : String(whole);
  }

  return {
    DECIMALS: DECIMALS,
    SCALE: SCALE,
    GLDX_MINT: GLDX_MINT,
    INCINERATOR: INCINERATOR,
    MIN_SWAP: MIN_SWAP,
    RATES: RATES,
    creditFor: creditFor,
    earmarkOf: earmarkOf,
    allocate: allocate,
    format: format
  };
});
