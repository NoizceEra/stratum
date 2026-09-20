/**
 * crafting.js — depth on top of economy.js's recipe list: crafting more than one item
 * per request, and reversing a craft you regret.
 *
 * WHY THIS FILE EXISTS
 *   Until now, crafting was strictly one recipe -> one item per 'craft' message, with no
 *   way back — a mistaken craft (wrong tier, wrong item) just sat in inventory forever,
 *   and stocking up on anything meant clicking the same recipe card over and over. This
 *   module adds two things, both pure math over economy.js's existing recipe/inventory
 *   shapes (this file never requires economy.js directly — same dependency-free
 *   convention as every other src/ module; the caller passes recipe data in):
 *     - BATCH CRAFTING: pay N x a recipe's cost, get N x its output, in one call.
 *     - SALVAGE: break down a held crafted item back into a partial materials refund.
 *   Batch crafting is also a genuine anti-cheat improvement, not just a convenience: one
 *   legitimate batch request now does the job that used to take dozens of individual
 *   'craft' messages, which is exactly the kind of rapid-fire message pattern
 *   src/anti-cheat.js's RATE signal watches for. Fewer, larger, legitimate requests mean
 *   fewer false-positive-shaped bursts from players who are just stocking up.
 *
 * SALVAGE ECONOMICS
 *   A flat, tunable basis-points refund (SALVAGE_REFUND_BPS, same FEE_DENOM=10000
 *   convention as every other bps knob in this codebase — parcels.js, shops.js,
 *   token-sink.js) applied per input material, floored. A malformed/missing refundBps
 *   falls back to the real default rather than to 0% or 100% — same reasoning as
 *   token-sink.js's splitBurn(): the wrong failure direction here would either shortchange
 *   a player on a config glitch or let materials be recycled at face value indefinitely
 *   (craft then salvage at 100% is a free do-over loop that undermines every recipe cost
 *   in the game). Never refunds more than was actually paid; a recipe with a zero-cost
 *   input naturally refunds zero of it.
 *
 * CONTRACT — same as every other module in src/:
 *   - Dependency-free UMD. No require of other project files, no DOM, no I/O.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(). Integer math
 *     throughout, same as every other economy module — every quantity here is a whole
 *     unit, never a fraction.
 *   - Every helper returns fresh objects and never mutates its arguments.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Crafting = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function isPosInt(n) { return isInt(n) && n > 0; }
  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ======================================================================
  // batch crafting
  // ======================================================================

  /** Ceiling on a single batch request — generous enough to be a real convenience, small
   *  enough that one message can never mint an absurd pile of gear in one shot. */
  var MAX_BATCH = 20;
  var MIN_BATCH = 1;

  /**
   * Validate a requested batch count. Returns { ok:true, count } (a clamped-nowhere,
   * exactly-as-requested integer, MIN_BATCH..MAX_BATCH inclusive) or { ok:false, error }.
   * Never mutates anything — the caller applies the actual inventory change.
   */
  function validateBatchCount(count) {
    if (!isInt(count) || count < MIN_BATCH) return { ok: false, error: 'bad count', count: null };
    if (count > MAX_BATCH) return { ok: false, error: 'batch too large (max ' + MAX_BATCH + ')', count: null };
    return { ok: true, error: null, count: count };
  }

  /**
   * `inputs` (a { resource: amount, ... } cost object, e.g. a recipe's `inputs`) scaled by
   * `count`. Returns a fresh object, or null if either argument is malformed. Every
   * resulting amount is still a whole integer — the caller's `inputs` values are assumed
   * already whole, same convention as every recipe in economy.js.
   */
  function batchCost(inputs, count) {
    if (!isPlainObject(inputs) || !isPosInt(count)) return null;
    var out = {};
    for (var k in inputs) {
      if (!Object.prototype.hasOwnProperty.call(inputs, k)) continue;
      var v = inputs[k];
      if (!isInt(v) || v < 0) return null;
      out[k] = v * count;
    }
    return out;
  }

  /** `outputCount` (a recipe's `output.count`) scaled by `count`. null on bad args. */
  function batchOutputCount(outputCount, count) {
    if (!isPosInt(outputCount) || !isPosInt(count)) return null;
    return outputCount * count;
  }

  // ======================================================================
  // salvage
  // ======================================================================

  var FEE_DENOM = 10000;
  /** Default salvage refund: 50% of a recipe's original inputs, per material, floored.
   *  Deliberately well under 100% — see the file header for why a full-value refund would
   *  make crafting free to "try" indefinitely. */
  var SALVAGE_REFUND_BPS = 5000;
  /** A salvage request for fewer than this many items is never valid. */
  var MIN_SALVAGE_COUNT = 1;

  /**
   * Materials refunded for salvaging ONE crafted item whose recipe cost `inputs`, at
   * `refundBps` (falls back to SALVAGE_REFUND_BPS for a missing/out-of-range value — see
   * the file header for why "no refund" would be the wrong failure direction here, same
   * reasoning as splitBurn() in token-sink.js). Every amount is floored independently, so
   * a 1-unit input can floor to 0 refunded at less than 100% — salvaging is a partial
   * recovery, never a guaranteed non-zero return on every material. Malformed `inputs` ->
   * an empty object, never throws.
   */
  function salvageRefund(inputs, refundBps) {
    if (!isPlainObject(inputs)) return {};
    var bps = (isInt(refundBps) && refundBps >= 0 && refundBps <= FEE_DENOM) ? refundBps : SALVAGE_REFUND_BPS;
    var out = {};
    for (var k in inputs) {
      if (!Object.prototype.hasOwnProperty.call(inputs, k)) continue;
      var v = inputs[k];
      if (!isInt(v) || v <= 0) continue;
      var refunded = Math.floor((v * bps) / FEE_DENOM);
      if (refunded > 0) out[k] = refunded;
    }
    return out;
  }

  /**
   * `inputs` refunded for salvaging `count` items at once — salvageRefund() applied per
   * item and summed, NOT (refund-per-item-batch * count) computed as one multiply; this
   * matters because flooring per-item is the fair, exploit-resistant behavior (salvaging
   * 3 items one-at-a-time must refund the same total as salvaging 3 at once — a single
   * batched floor could round more favorably and make bulk-salvage strictly better than
   * repeated single salvage, which would be a real economic exploit). Null on bad args.
   */
  function batchSalvageRefund(inputs, count, refundBps) {
    if (!isPlainObject(inputs) || !isPosInt(count)) return null;
    var per = salvageRefund(inputs, refundBps);
    var out = {};
    for (var k in per) out[k] = per[k] * count;
    return out;
  }

  /**
   * Validate a salvage request against how many of the item the player actually holds.
   * Returns { ok:true, count } or { ok:false, error }. Never mutates anything.
   */
  function validateSalvageCount(count, held) {
    if (!isInt(count) || count < MIN_SALVAGE_COUNT) return { ok: false, error: 'bad count', count: null };
    if (!isInt(held) || held < MIN_SALVAGE_COUNT) return { ok: false, error: 'nothing to salvage', count: null };
    if (count > held) return { ok: false, error: 'do not hold that many', count: null };
    return { ok: true, error: null, count: count };
  }

  return {
    MAX_BATCH: MAX_BATCH,
    MIN_BATCH: MIN_BATCH,
    FEE_DENOM: FEE_DENOM,
    SALVAGE_REFUND_BPS: SALVAGE_REFUND_BPS,
    MIN_SALVAGE_COUNT: MIN_SALVAGE_COUNT,
    validateBatchCount: validateBatchCount,       // { ok, count, error } against MAX_BATCH
    batchCost: batchCost,                         // inputs scaled by count, or null
    batchOutputCount: batchOutputCount,           // output.count scaled by count, or null
    salvageRefund: salvageRefund,                 // refund for ONE item's inputs
    batchSalvageRefund: batchSalvageRefund,       // refund for `count` items, floored per-item
    validateSalvageCount: validateSalvageCount    // { ok, count, error } against held count
  };
});
