/**
 * shops.js — player shop escrow math for STRATUM.
 *
 * WHY THIS FILE EXISTS
 *   Player shops are simple item-for-item barter listings anchored to a claimed tile
 *   (server.js enforces the land-ownership + reach checks; this module only ever sees
 *   plain data). The trust-sensitive part is the escrow arithmetic: goods must leave the
 *   seller's inventory the instant a listing is created (never re-checked and re-spent
 *   later), and a purchase must move payment and goods in one atomic step. Keeping that
 *   math in one pure, exhaustively-tested module — mirroring economy.js's
 *   canAfford/applyCost style exactly — is what makes it safe to reason about.
 *
 * PRICING MODEL (a deliberate simplification, stated here so it isn't rediscovered by
 * reading call sites): `priceItem`/`priceQty` is a PER-UNIT price, not a total for the
 * whole listing. "5 ore for 2 wood" means each 1 ore costs 2 wood; a buyer may buy any
 * amount up to the remaining stock and pays exactly `priceQty * buyQty`. This avoids any
 * rounding/remainder question a "2 wood for the whole stack of 5 ore" model would raise
 * (what does a partial-stack purchase cost?) — per-unit pricing has no such case, which
 * is why it's the boring, obviously-correct choice here.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Shops = {...}` when
 *     loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - Inventories are flat plain objects, same shape as economy.js/drops.js use.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Shops = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** True for a finite integer; used to reject garbage input. */
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  /** True for a positive finite integer — the shape every quantity in this module needs. */
  function isPosInt(n) { return isInt(n) && n > 0; }
  /** True for a non-empty string — item ids are never numbers, objects, or ''. */
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
    return (isInt(v) && v > 0) ? v : 0;
  }

  /** Ceiling on any single quantity in a listing — guards against overflow/silly listings. */
  var MAX_QTY = 1000000;

  /**
   * Validate the shape of a would-be listing (server.js still checks that `item` and
   * `priceItem` are real catalog entries — this module only knows about generic barter
   * math, not the game's item catalog). Returns { ok, error }.
   */
  function validListing(item, qty, priceItem, priceQty) {
    if (!isName(item)) return { ok: false, error: 'bad item' };
    if (!isName(priceItem)) return { ok: false, error: 'bad price item' };
    if (item === priceItem) return { ok: false, error: 'cannot price an item in itself' };
    if (!isPosInt(qty) || qty > MAX_QTY) return { ok: false, error: 'bad quantity' };
    if (!isPosInt(priceQty) || priceQty > MAX_QTY) return { ok: false, error: 'bad price' };
    return { ok: true, error: null };
  }

  /** True if `inv` holds at least `qty` of `item` — the affordability check for listing. */
  function canEscrow(inv, item, qty) {
    return isName(item) && isPosInt(qty) && held(inv, item) >= qty;
  }

  /**
   * The escrow step: a NEW inventory with `qty` of `item` removed, or null if `inv`
   * cannot pay it. This is what "the seller's offered goods are moved OUT of their live
   * inventory the moment the listing is created" means in code — called once, at listing
   * creation, and never again for that stock.
   */
  function escrow(inv, item, qty) {
    if (!canEscrow(inv, item, qty)) return null;
    var out = cloneInv(inv);
    out[item] = held(inv, item) - qty;
    return out;
  }

  /** Cost in `priceItem` of buying `buyQty` units at a listing's per-unit `priceQty`. */
  function costFor(priceQty, buyQty) {
    if (!isPosInt(priceQty) || !isPosInt(buyQty)) return 0;
    return priceQty * buyQty;
  }

  /** True if `buyQty` units of `listing` can be bought right now by `buyerInv`. */
  function canBuy(listing, buyerInv, buyQty) {
    if (!listing || !isPosInt(buyQty) || buyQty > listing.qty) return false;
    return held(buyerInv, listing.priceItem) >= costFor(listing.priceQty, buyQty);
  }

  /**
   * Resolve a purchase of `buyQty` units of `listing` against `buyerInv`.
   * Returns { ok:true, buyerInv (NEW), cost, remainingQty } — `cost` is what the caller
   * must credit to the seller (who may be offline), exactly as `priceQty * buyQty` units
   * of `listing.priceItem`; `remainingQty` is what is left in escrow after this sale, for
   * the caller to persist (0 means the listing sold out and should be removed).
   * Returns { ok:false, error } on any invalid input. Never mutates `buyerInv` or `listing`.
   */
  function buy(listing, buyerInv, buyQty) {
    if (!listing || typeof listing !== 'object') return { ok: false, error: 'no such listing' };
    if (!isPosInt(buyQty)) return { ok: false, error: 'bad quantity' };
    if (buyQty > listing.qty) return { ok: false, error: 'not enough stock' };
    var cost = costFor(listing.priceQty, buyQty);
    if (held(buyerInv, listing.priceItem) < cost) return { ok: false, error: 'cannot afford' };
    var out = cloneInv(buyerInv);
    out[listing.priceItem] = held(buyerInv, listing.priceItem) - cost;
    out[listing.item] = held(buyerInv, listing.item) + buyQty;
    return { ok: true, error: null, buyerInv: out, cost: cost, remainingQty: listing.qty - buyQty };
  }

  return {
    MAX_QTY: MAX_QTY,
    validListing: validListing,   // { ok, error } — shape/sanity check for a new listing.
    canEscrow: canEscrow,         // can `inv` afford to list `qty` of `item`?
    escrow: escrow,               // NEW inv with `qty` of `item` removed, or null.
    costFor: costFor,             // priceQty * buyQty (0 for bad input).
    canBuy: canBuy,               // can `buyQty` units be bought right now?
    buy: buy                      // { ok, buyerInv (NEW), cost, remainingQty } or { ok:false, error }.
  };
});
