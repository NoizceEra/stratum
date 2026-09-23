/**
 * trade.js — escrowed direct player-to-player trade for STRATUM.
 *
 * WHY THIS FILE EXISTS
 *   Shops (shops.js) sell to anyone within reach. This is the other half of "Society":
 *   a trade addressed to one specific player, for a gift or a real two-sided swap,
 *   resolved without either side needing to be online at the same moment.
 *
 * FLOW (the "simplest safe" pattern from ROADMAP_COZY.md's open questions)
 *   1. A creates an offer addressed to B: what A gives (`giveItem`/`giveQty`), and
 *      optionally what A wants back (`wantItem`/`wantQty` — omitted/zero means a pure
 *      gift). A's give-side is escrowed THE MOMENT the offer is created (server.js calls
 *      `escrowGive` once, right there) — it leaves A's inventory and sits in the offer
 *      record, never re-checked or re-spent.
 *   2. B accepts. If the offer wants something back, B must have it AT THE MOMENT OF
 *      ACCEPTING and it is deducted from B as part of that same atomic step — there is no
 *      separate "B escrows first" phase, because accept is a single synchronous call
 *      (`accept`) that either fully succeeds or fully fails. A's escrowed goods move to B;
 *      whatever B paid is credited to A (who may be offline — server.js credits A's
 *      persisted state the same way an offline shop sale is credited).
 *   3. Only A (the offerer) may cancel an open offer, returning the escrowed goods to A.
 *      B never has anything at stake before accepting, so B has nothing to "cancel" —
 *      declining is simply never accepting, and the offer expires on its own (see TTL).
 *   4. TTL: an offer nobody accepts expires after a generous window (default 7 days, per
 *      ROADMAP_COZY.md's open questions) and returns A's escrow — same lazy-expiry shape
 *      as src/drops.js's `expired`/`describe` pattern, just applied to a trade offer
 *      instead of a loot cache.
 *
 *   Open (unaddressed, "anyone can accept") offers are deliberately NOT supported: an
 *   addressed offer needs no extra concurrency handling (only one player can ever be the
 *   accepter), while an open offer would need a race-safe "first acceptor wins, everyone
 *   else is refused" rule for no real benefit in a small-scale cozy economy. Addressed-only
 *   is the boring, obviously-correct choice for v1.
 *
 * CONTRACT (identical to shops.js / economy.js / drops.js)
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Trade = {...}` when
 *     loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Every helper returns fresh objects
 *     and NEVER mutates its arguments.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Trade = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** True for a finite integer; used to reject garbage input. */
  function isFiniteInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  /** True for a positive finite integer. */
  function isPosInt(n) { return isFiniteInt(n) && n > 0; }
  /** True for a non-empty string. */
  function isName(s) { return typeof s === 'string' && s.length > 0; }

  /** Copy an inventory, preserving unknown keys, without touching the original. */
  function cloneInv(inv) {
    var out = {};
    if (inv && typeof inv === 'object') {
      for (var k in inv) if (Object.prototype.hasOwnProperty.call(inv, k)) out[k] = inv[k];
    }
    return out;
  }

  /** How many of `key` an inventory holds; absent / negative / NaN all read as 0. */
  function held(inv, key) {
    var v = inv ? inv[key] : 0;
    return (isFiniteInt(v) && v > 0) ? v : 0;
  }

  /** Default lifetime of an unanswered offer: 7 days, in milliseconds. */
  var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /**
   * Validate + normalise a would-be offer's give/want fields. Returns
   * { ok:true, wantItem, wantQty } (wantItem is null and wantQty is 0 for a pure gift) or
   * { ok:false, error }. `wantItem`/`wantQty` are "present" only when wantItem is a
   * non-empty string AND wantQty is a positive integer — any other combination (one given
   * without the other, or a zero/negative quantity) is treated as "no want side" rather
   * than silently accepted as malformed data.
   */
  function validOffer(giveItem, giveQty, wantItem, wantQty) {
    if (!isName(giveItem)) return { ok: false, error: 'bad give item' };
    if (!isPosInt(giveQty)) return { ok: false, error: 'bad give quantity' };
    var wantNamed = isName(wantItem);
    if (wantNamed) {
      if (!isPosInt(wantQty)) return { ok: false, error: 'bad want quantity' };
      if (wantItem === giveItem) return { ok: false, error: 'cannot trade an item for itself' };
      return { ok: true, error: null, wantItem: wantItem, wantQty: wantQty };
    }
    return { ok: true, error: null, wantItem: null, wantQty: 0 };
  }

  /** True if `inv` can afford to escrow `giveQty` of `giveItem` at offer creation. */
  function canEscrowGive(inv, giveItem, giveQty) {
    return isName(giveItem) && isPosInt(giveQty) && held(inv, giveItem) >= giveQty;
  }

  /**
   * The escrow step at offer creation: a NEW inventory with `giveQty` of `giveItem`
   * removed, or null if it cannot be paid. Mirrors shops.js's `escrow` exactly.
   */
  function escrowGive(inv, giveItem, giveQty) {
    if (!canEscrowGive(inv, giveItem, giveQty)) return null;
    var out = cloneInv(inv);
    out[giveItem] = held(inv, giveItem) - giveQty;
    return out;
  }

  /** True once an offer has aged past its ttl: (now - createdAt) > ttlMs. Malformed input is expired. */
  function expired(offer, now) {
    if (!offer || typeof offer !== 'object') return true;
    if (!isFiniteInt(offer.createdAt) || !isFiniteInt(offer.ttlMs) || !isFiniteInt(now)) return true;
    return (now - offer.createdAt) > offer.ttlMs;
  }

  /** Display name for a resource key. Saves + wire protocol still say `gold`. */
  function dispKey(k) { return k; }

  /** A short human line for an offer: '3 wood for 1 ore', or '3 wood (gift)'. */
  function describe(offer) {
    if (!offer || typeof offer !== 'object' || !isName(offer.giveItem) || !isFiniteInt(offer.giveQty)) {
      return 'an empty offer';
    }
    var give = offer.giveQty + ' ' + dispKey(offer.giveItem);
    if (offer.wantItem && offer.wantQty > 0) return give + ' for ' + offer.wantQty + ' ' + dispKey(offer.wantItem);
    return give + ' (gift)';
  }

  /** True if `accepterInv` can pay whatever this offer asks back (always true for a gift). */
  function canAccept(offer, accepterInv) {
    if (!offer || typeof offer !== 'object') return false;
    if (!offer.wantItem || !offer.wantQty) return true;
    return held(accepterInv, offer.wantItem) >= offer.wantQty;
  }

  /**
   * Resolve B accepting `offer`. In ONE step: if the offer wants something back, it is
   * deducted from `accepterInv` (failing the whole call if B cannot afford it — nothing
   * is partially applied); `offer.giveItem`/`giveQty` (A's already-escrowed goods) is
   * added to `accepterInv`. Returns { ok:true, accepterInv (NEW), paid } — `paid` is what
   * B handed over (0 for a pure gift), which the caller credits to A (who may be offline)
   * the same way an offline shop sale is credited. Returns { ok:false, error } on failure.
   * Never mutates `accepterInv` or `offer`.
   */
  function accept(offer, accepterInv) {
    if (!offer || typeof offer !== 'object') return { ok: false, error: 'no such offer' };
    if (!isName(offer.giveItem) || !isPosInt(offer.giveQty)) return { ok: false, error: 'malformed offer' };
    var out = cloneInv(accepterInv);
    var paid = 0;
    if (offer.wantItem && offer.wantQty > 0) {
      if (held(accepterInv, offer.wantItem) < offer.wantQty) return { ok: false, error: 'cannot afford' };
      out[offer.wantItem] = held(accepterInv, offer.wantItem) - offer.wantQty;
      paid = offer.wantQty;
    }
    out[offer.giveItem] = held(accepterInv, offer.giveItem) + offer.giveQty;
    return { ok: true, error: null, accepterInv: out, paid: paid };
  }

  return {
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    validOffer: validOffer,       // { ok, wantItem, wantQty } or { ok:false, error }.
    canEscrowGive: canEscrowGive, // can the offerer afford to escrow the give side?
    escrowGive: escrowGive,       // NEW inv with the give side removed, or null.
    expired: expired,             // true once (now - createdAt) > ttlMs.
    describe: describe,           // human-readable one-liner.
    canAccept: canAccept,         // can the accepter pay the want side right now?
    accept: accept                // { ok, accepterInv (NEW), paid } or { ok:false, error }.
  };
});
