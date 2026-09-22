/**
 * payout.js — fee math for the two wallet-gated exits: claim and convert.
 *
 * Play never calls this. Harvesting, crafting, and kills still credit silver and
 * pending STRM with no wallet and no fee (src/rewards.js). A player only hits
 * this module once they connect a wallet and ask to:
 *   - claim: turn pending STRM into an on-chain payout (server sends `payout`,
 *     the treasury keeps `fee` — that cut never leaves the treasury wallet)
 *   - convert: swap silver <-> pending STRM. The fee is STRM credited to the
 *     in-game treasury vault. Convert does not touch the chain.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O.
 *   - Pure + deterministic. Never mutates arguments. Never throws.
 *   - Integer STRM and silver only. Fee is floor(gross * bps / 10000).
 *   - `fee + payout === gross` whenever a quote is ok.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Payout = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var FEE_DENOM = 10000;
  /** 2.5% — same cut as parcel deeds and shop sales. */
  var CLAIM_FEE_BPS = 250;
  var CONVERT_FEE_BPS = 250;
  /** Whole silver spent to mint one gross STRM before the convert fee. */
  var GOLD_PER_STRM = 10;
  /**
   * Smallest gross STRM a convert will touch. 2.5% of 40 is 1, so the fee is
   * a real unit instead of flooring away to zero. Claim has its own floor in
   * server.js (gas), separate from this.
   */
  var MIN_CONVERT_STRM = 40;

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function isPosInt(n) { return isInt(n) && n > 0; }

  function bpsOf(bps, fallback) {
    return (isInt(bps) && bps >= 0 && bps <= FEE_DENOM) ? bps : fallback;
  }

  function splitFee(gross, bps, fallbackBps) {
    if (!isPosInt(gross)) return { fee: 0, payout: 0 };
    var b = bpsOf(bps, fallbackBps);
    var fee = Math.floor((gross * b) / FEE_DENOM);
    return { fee: fee, payout: gross - fee };
  }

  /**
   * Quote a claim of the entire pending balance.
   * Returns { ok, gross, fee, payout, error, minClaim }.
   */
  function quoteClaim(pending, feeBps, minClaim) {
    var min = isPosInt(minClaim) ? minClaim : 1;
    if (!isPosInt(pending)) return { ok: false, error: 'nothing pending', gross: 0, fee: 0, payout: 0, minClaim: min };
    if (pending < min) {
      return { ok: false, error: 'below minimum claim (' + min + ')', gross: pending, fee: 0, payout: 0, minClaim: min };
    }
    var s = splitFee(pending, feeBps, CLAIM_FEE_BPS);
    if (s.payout < 1) {
      return { ok: false, error: 'fee consumes claim', gross: pending, fee: s.fee, payout: 0, minClaim: min };
    }
    return { ok: true, error: null, gross: pending, fee: s.fee, payout: s.payout, minClaim: min };
  }

  /**
   * Quote a convert.
   *   dir 'to-token' — `amount` is silver to spend (omit to spend all silver)
   *   dir 'to-gold'  — `amount` is pending STRM to spend (omit to spend all)
   * `balances` is { gold, pending } (wire field names). `opts` is { feeBps, goldPerStrm, minStrm }.
   * On success, to-token spends `spentGold` and mints `payout` pending STRM
   * (fee STRM goes to the treasury, not the player). to-gold spends `gross`
   * pending STRM and grants `goldOut` silver.
   */
  function quoteConvert(dir, amount, balances, opts) {
    var o = opts || {};
    var rate = isPosInt(o.goldPerStrm) ? o.goldPerStrm : GOLD_PER_STRM;
    var minStrm = isPosInt(o.minStrm) ? o.minStrm : MIN_CONVERT_STRM;
    var gold = (balances && isInt(balances.gold) && balances.gold > 0) ? balances.gold : 0;
    var pending = (balances && isInt(balances.pending) && balances.pending > 0) ? balances.pending : 0;
    var fail = function (error) {
      return { ok: false, error: error, dir: dir, gross: 0, fee: 0, payout: 0, spentGold: 0, goldOut: 0, minStrm: minStrm };
    };
    if (dir !== 'to-token' && dir !== 'to-gold') return fail('bad direction');

    if (dir === 'to-token') {
      var spend = (amount === undefined || amount === null) ? gold : amount;
      if (!isPosInt(spend)) return fail(gold > 0 ? 'bad amount' : 'nothing to convert');
      if (spend > gold) return fail('cannot afford');
      var gross = Math.floor(spend / rate);
      var spentGold = gross * rate;
      if (gross < 1) return fail('not enough silver');
      if (gross < minStrm) return fail('below minimum convert (' + minStrm + ')');
      var s = splitFee(gross, o.feeBps, CONVERT_FEE_BPS);
      if (s.payout < 1) return fail('fee consumes convert');
      return {
        ok: true, error: null, dir: dir, gross: gross, fee: s.fee, payout: s.payout,
        spentGold: spentGold, goldOut: 0, minStrm: minStrm
      };
    }

    var strm = (amount === undefined || amount === null) ? pending : amount;
    if (!isPosInt(strm)) return fail(pending > 0 ? 'bad amount' : 'nothing to convert');
    if (strm > pending) return fail('cannot afford');
    if (strm < minStrm) return fail('below minimum convert (' + minStrm + ')');
    var g = splitFee(strm, o.feeBps, CONVERT_FEE_BPS);
    if (g.payout < 1) return fail('fee consumes convert');
    return {
      ok: true, error: null, dir: dir, gross: strm, fee: g.fee, payout: g.payout,
      spentGold: 0, goldOut: g.payout * rate, minStrm: minStrm
    };
  }

  return {
    FEE_DENOM: FEE_DENOM,
    CLAIM_FEE_BPS: CLAIM_FEE_BPS,
    CONVERT_FEE_BPS: CONVERT_FEE_BPS,
    GOLD_PER_STRM: GOLD_PER_STRM,
    MIN_CONVERT_STRM: MIN_CONVERT_STRM,
    splitFee: splitFee,
    quoteClaim: quoteClaim,
    quoteConvert: quoteConvert
  };
});
