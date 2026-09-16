/**
 * token-sink.js — what happens to STRM when a player spends it in-game.
 *
 * WHY THIS FILE EXISTS
 *   Every previous piece of the commerce system only ever ADDS to a player's pending
 *   STRM balance (src/rewards.js mints it; nothing ever spent it — see the ROADMAP
 *   discussion this module is a direct answer to). A token that only ever accrues and
 *   never drains is the textbook play-to-earn failure mode: unbounded supply, no reason
 *   to hold it, value trending to zero as the faucet keeps running with nothing opposing
 *   it. This module is the drain. Every sink (Earth Requisition, Structure Rush, and
 *   whatever comes after) funnels through the same split: most of what's spent is
 *   BURNED — permanently destroyed, gone from the economy forever, not sitting anywhere
 *   waiting to be claimed — and a smaller slice is credited to the in-game treasury
 *   (server.js already has one, fed today only by marketplace fees; this becomes its
 *   second income source).
 *
 * WHAT "BURN" MEANS TODAY, CONCRETELY
 *   STRM has no live on-chain contract yet (src/token-config.js's CA is still a
 *   placeholder, src/chain-adapter.js still can't settle a claim). So a "burn" here is
 *   an off-chain ledger fact: the amount is removed from a player's spendable
 *   `pending` balance and added to a server-wide, permanent `token_burned` counter —
 *   it is NEVER added to anyone's `claimed` total, so there is nothing to later pay out
 *   for it. When real settlement eventually exists, this module's contract does not
 *   change: burned STRM was never owed to anyone, on-chain or off.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.TokenSink = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and never mutates its arguments.
 *   - Integer math throughout — STRM is whole ledger units, same as everywhere else in
 *     this codebase (src/rewards.js, the token_ledger table).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.TokenSink = api;
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

  // ======================================================================
  // the split every sink shares
  // ======================================================================

  /** Same basis-points convention as shops.js/parcels.js's fee math — N/10000, never a
   *  float percentage that could round two different ways in two different places. */
  var FEE_DENOM = 10000;
  /** Default burn rate: 80% destroyed, 20% to the in-game treasury. Deliberately burn-
   *  heavy — a sink whose treasury cut dominates is really just another fee, not a real
   *  drain on supply. Tunable by the caller (server.js reads it from env, same pattern
   *  as SHOP_FEE_BPS/PARCEL_FEE_BPS). */
  var BURN_BPS = 8000;

  /**
   * Split `amount` STRM into { burned, treasury }, using `burnBps` (falls back to
   * BURN_BPS for a missing/out-of-range value — unlike shops.js's feeFor, a sink
   * defaulting to "no burn" would be the WORSE failure direction here, since the whole
   * point is that spending always destroys most of what's spent). `burned` is the
   * floored majority share; `treasury` is exactly `amount - burned`, so the two always
   * sum to `amount` with no dust ever silently lost. Malformed `amount` -> zeros.
   */
  function splitBurn(amount, burnBps) {
    if (!isPosInt(amount)) return { burned: 0, treasury: 0 };
    var b = (isInt(burnBps) && burnBps >= 0 && burnBps <= FEE_DENOM) ? burnBps : BURN_BPS;
    var burned = Math.floor((amount * b) / FEE_DENOM);
    return { burned: burned, treasury: amount - burned };
  }

  // ======================================================================
  // sink 1: Earth Requisition — spend pending STRM directly for quota progress
  // ======================================================================

  /** Floor on a single requisition — a 0-or-negative request is never a valid spend. */
  var MIN_REQUISITION = 1;

  /**
   * Validate a requisition request against a player's current pending balance.
   * Returns { ok:true, amount } (amount clamped to an integer <= pending) or
   * { ok:false, error }. Never mutates anything — the caller applies the ledger change.
   */
  function validateRequisition(amount, pending) {
    if (!isInt(amount) || amount < MIN_REQUISITION) return { ok: false, error: 'bad amount' };
    if (!isInt(pending) || pending < MIN_REQUISITION) return { ok: false, error: 'nothing pending' };
    if (amount > pending) return { ok: false, error: 'cannot afford' };
    return { ok: true, amount: amount, error: null };
  }

  // ======================================================================
  // sink 2: Structure Rush — pay STRM to skip the wait on an idle structure
  // ======================================================================

  /** STRM cost per whole unit of resource skipped. Tunable by the caller. Deliberately
   *  a flat rate rather than scaling with the structure's tier/value — simplicity here
   *  matters more than precision-pricing a handful of structure kinds. */
  var RUSH_COST_PER_UNIT = 2;

  /**
   * Cost in STRM to instantly fill the remaining `capacity - accrued` gap of a structure.
   * `accrued`/`capacity` are whole resource units (src/idle.js's own vocabulary — this
   * module never touches idle.js directly, the caller passes the numbers in, keeping the
   * two modules independent and each independently testable).
   * Returns { cost, gained } — `gained` is how many units rushing would actually add
   * (0 if already full or malformed input, in which case `cost` is also 0: never charge
   * for nothing). `costPerUnit` optional, falls back to RUSH_COST_PER_UNIT.
   */
  function rushCost(accrued, capacity, costPerUnit) {
    if (!isInt(accrued) || accrued < 0 || !isInt(capacity) || capacity <= 0 || accrued >= capacity) {
      return { cost: 0, gained: 0 };
    }
    var rate = (isPosInt(costPerUnit)) ? costPerUnit : RUSH_COST_PER_UNIT;
    var gained = capacity - accrued;
    return { cost: gained * rate, gained: gained };
  }

  return {
    FEE_DENOM: FEE_DENOM,
    BURN_BPS: BURN_BPS,
    MIN_REQUISITION: MIN_REQUISITION,
    RUSH_COST_PER_UNIT: RUSH_COST_PER_UNIT,
    splitBurn: splitBurn,               // { burned, treasury } summing exactly to amount.
    validateRequisition: validateRequisition, // { ok, amount, error } against a pending balance.
    rushCost: rushCost                  // { cost, gained } to instantly fill a structure's gap.
  };
});
