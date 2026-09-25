/**
 * tithes.js — settler standing orders: subscribe-and-forget yield for a price.
 *
 * WHY THIS FILE EXISTS
 *   Every sink so far is a one-shot purchase. A tithe is a relationship: pay a
 *   steep entry once (50,000 STRATUM, fixed — not tuned, not env'd), hold a
 *   permanent +10% reward-yield boost while subscribed, and pay 100 STRATUM/week
 *   upkeep (burn-split like every sink) or the tithe lapses. Holders get
 *   fire-and-forget yield; the economy gets a recurring drain instead of another
 *   one-time purchase. Cancel anytime, free — only the week already paid is gone.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Never throws, never mutates.
 *   - Integer STRATUM throughout. Settler ids mirror public/settlers.js SETTLERS ids.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Tithes = api;
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

  /** Fixed entry price. Deliberately NOT env-tunable — the number is the product. */
  var ENTRY = 50000;
  /** Weekly upkeep from pending. Env-tunable server-side (STRATUM_TITHE_WEEKLY). */
  var WEEKLY = 100;
  var WEEK_MS = 7 * 24 * 3600 * 1000;
  /** Yield multiplier while any tithe is active. */
  var MULT = 1.10;

  var SETTLERS = deepFreeze(['sable', 'dray', 'ilo']);

  function isSettler(id) {
    if (typeof id !== 'string') return false;
    for (var i = 0; i < SETTLERS.length; i++) if (SETTLERS[i] === id) return true;
    return false;
  }

  /**
   * Validate starting (or re-starting) a tithe. `owned` is array/Set/map of
   * settler ids already tithed (any shape hasId-style). Returns { ok, price, error }.
   */
  function validateStart(settler, pending, owned) {
    if (!isSettler(settler)) return { ok: false, price: 0, error: 'unknown settler' };
    if (owned) {
      if (typeof owned.has === 'function') { try { if (owned.has(settler)) return { ok: false, price: 0, error: 'already tithing' }; } catch (e) {} }
      else if (Array.isArray(owned)) { if (owned.indexOf(settler) !== -1) return { ok: false, price: 0, error: 'already tithing' }; }
      else if (typeof owned === 'object') { if (owned[settler]) return { ok: false, price: 0, error: 'already tithing' }; }
    }
    if (!isInt(pending) || pending < ENTRY) return { ok: false, price: ENTRY, error: 'need 50000 STRATUM pending' };
    return { ok: true, price: ENTRY, error: null };
  }

  /**
   * Weekly upkeep decision for one tithe row ({ lastUpkeepAt }). Returns
   * { due:true } when a week elapsed, { due:false } otherwise. Never throws.
   */
  function upkeepDue(row, now) {
    try {
      if (!row || typeof row !== 'object') return { due: false };
      if (typeof now !== 'number' || !isFinite(now) || now < 0) return { due: false };
      var last = row.lastUpkeepAt;
      if (typeof last !== 'number' || !isFinite(last) || last < 0) return { due: true };
      return { due: (now - last) >= WEEK_MS };
    } catch (e) { return { due: false }; }
  }

  /**
   * Settle one due upkeep against `pending`. Returns
   * { ok:true, paid } (paid deducted, burn-split by caller) or
   * { ok:false } (unaffordable — caller lapses the tithe). Never throws.
   */
  function settleUpkeep(pending, weekly) {
    var w = isPosInt(weekly) ? weekly : WEEKLY;
    if (!isInt(pending) || pending < w) return { ok: false, paid: 0 };
    return { ok: true, paid: w };
  }

  return {
    ENTRY: ENTRY,
    WEEKLY: WEEKLY,
    WEEK_MS: WEEK_MS,
    MULT: MULT,
    SETTLERS: SETTLERS,
    isSettler: isSettler,
    validateStart: validateStart,
    upkeepDue: upkeepDue,
    settleUpkeep: settleUpkeep
  };
});
