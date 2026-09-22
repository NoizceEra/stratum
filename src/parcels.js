/**
 * parcels.js — land-parcel deeds for STRATUM's player-priced marketplace.
 *
 * WHY THIS FILE EXISTS
 *   Land is the only truly scarce resource (finite world, never resets, never
 *   expands) — but today a tile can only be claimed or released back to the
 *   commons. It can never be sold or gifted. So players trade *things* but never
 *   *places*, and the economy has no property market.
 *
 *   A parcel is a named deed over a set of the minter's own contiguous claimed
 *   tiles. The deed is a *view*, not a migration: tiles stay individually owned
 *   underneath (same `tiles` map + `tiles_owner` index), the deed row just names
 *   the set. Listing/sale is escrowed exactly like shops.js/trade.js — one atomic
 *   synchronous step, seller may be offline, nothing moves without both sides'
 *   consent captured server-side. The game takes a fixed treasury fee (basis
 *   points) on every deed sale: that is the monetization — profit from players
 *   trading with each other, priced by users, settled by the system.
 *
 * CONTRACT (identical to shops.js / trade.js / economy.js)
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Parcels = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is NEVER needed here (deeds don't expire — land is permanent; only the
 *     *listing* carries the 7-day TTL, owned by the caller, same as trade offers).
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Parcels = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** True for a finite integer; used to reject garbage input. */
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  /** True for a positive finite integer. */
  function isPosInt(n) { return isInt(n) && n > 0; }
  /** True for a non-empty string. */
  function isName(s) { return typeof s === 'string' && s.length > 0; }

  /** Treasury fee: 250 bps = 2.5% of every deed sale. Integer math, floored. */
  var FEE_BPS = 250;
  var FEE_DENOM = 10000;
  /** Largest deed: 256 tiles (e.g. 16x16). Bounds one record's blast radius. */
  var MAX_DEED_TILES = 256;
  /** Longest parcel display name (same spirit as the 18-char player names). */
  var MAX_NAME = 24;
  /** Ceiling on any single price — mirrors shops.js MAX_QTY. */
  var MAX_QTY = 1000000;

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

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

  /**
   * Normalize a tile list: dedupe, drop malformed entries, sort by (y, x).
   * Returns the clean array, or null when nothing usable remains, when the input
   * isn't an array, or when it exceeds MAX_DEED_TILES. Never throws.
   */
  function normalizeTiles(tiles) {
    if (!Array.isArray(tiles) || tiles.length === 0 || tiles.length > MAX_DEED_TILES) return null;
    var seen = {}, out = [];
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t || typeof t !== 'object') return null;
      if (!isInt(t.x) || !isInt(t.y) || t.x < 0 || t.y < 0) return null;
      var k = t.x + ':' + t.y;
      if (seen[k]) continue;
      seen[k] = true;
      out.push({ x: t.x, y: t.y });
    }
    if (!out.length) return null;
    out.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    return out;
  }

  /**
   * True when every tile in a *normalized* list connects to the rest through
   * 4-neighbourhood steps (up/down/left/right — diagonals don't count). A single
   * tile is trivially contiguous. Pure BFS, no mutation.
   */
  function isContiguous(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return false;
    var set = {};
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t || !isInt(t.x) || !isInt(t.y)) return false;
      set[t.x + ':' + t.y] = true;
    }
    var seen = {}, queue = [tiles[0]], count = 0;
    seen[tiles[0].x + ':' + tiles[0].y] = true;
    while (queue.length) {
      var c = queue.pop();
      count++;
      var nbs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var d = 0; d < 4; d++) {
        var k = (c.x + nbs[d][0]) + ':' + (c.y + nbs[d][1]);
        if (set[k] && !seen[k]) { seen[k] = true; queue.push({ x: c.x + nbs[d][0], y: c.y + nbs[d][1] }); }
      }
    }
    return count === tiles.length;
  }

  /** Bounding box of a normalized tile list: {x0,y0,x1,y1,w,h,n}. Null on bad input. */
  function bbox(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      if (!t || !isInt(t.x) || !isInt(t.y)) return null;
      if (t.x < x0) x0 = t.x;
      if (t.y < y0) y0 = t.y;
      if (t.x > x1) x1 = t.x;
      if (t.y > y1) y1 = t.y;
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n: tiles.length };
  }

  /** Clean a display name the way the server cleans player names: bounded, no control chars. */
  function cleanName(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  }

  /**
   * Validate a would-be deed (server.js still checks that every tile is actually
   * owned by the minter — this module only knows shapes, not ownership).
   * Returns { ok:true, tiles (normalized fresh), name } or { ok:false, error }.
   */
  function validateDeed(tiles, name) {
    var norm = normalizeTiles(tiles);
    if (!norm) return { ok: false, error: 'bad tiles' };
    if (!isContiguous(norm)) return { ok: false, error: 'tiles must form one contiguous parcel (4-neighbourhood)' };
    var nm = cleanName(name);
    if (!nm) return { ok: false, error: 'bad name' };
    return { ok: true, error: null, tiles: norm, name: nm };
  }

  /**
   * Treasury fee on a sale price, in the same units as the price. Integer math,
   * floored — a 1-silver sale yields a 0 fee, which is fine (no dust chasing).
   * `bps` defaults to FEE_BPS; the caller (server) passes the live value so a
   * future fee change is a one-line config edit, not a module edit.
   */
  function feeFor(priceQty, bps) {
    var b = (isInt(bps) && bps >= 0 && bps <= FEE_DENOM) ? bps : FEE_BPS;
    if (!isPosInt(priceQty)) return 0;
    return Math.floor((priceQty * b) / FEE_DENOM);
  }

  /**
   * Validate a deed listing price (shape only — the catalog check, if any, stays
   * with the caller, same split as shops.js). Returns { ok, error }.
   */
  function validListing(priceItem, priceQty) {
    if (!isName(priceItem)) return { ok: false, error: 'bad price item' };
    if (!isPosInt(priceQty) || priceQty > MAX_QTY) return { ok: false, error: 'bad price' };
    return { ok: true, error: null };
  }

  /**
   * Resolve a deed purchase. ONE atomic step, mirroring shops.js `buy`:
   * the buyer pays the FULL price; the seller is credited `price - fee` and the
   * treasury is credited `fee` (both as plain amounts for the caller to persist —
   * the seller may be offline, so the caller credits persisted state, never a live
   * object). The deed + every underlying tile flips to the buyer in the same step.
   *
   * Returns { ok:true, buyerInv (NEW), sellerGets, treasuryGets, priceItem } or
   * { ok:false, error }. Never mutates `buyerInv`.
   */
  function swapDeed(buyerInv, priceItem, priceQty, feeBps) {
    if (!isName(priceItem)) return { ok: false, error: 'bad price item' };
    if (!isPosInt(priceQty) || priceQty > MAX_QTY) return { ok: false, error: 'bad price' };
    if (held(buyerInv, priceItem) < priceQty) return { ok: false, error: 'cannot afford' };
    var fee = feeFor(priceQty, feeBps);
    var out = cloneInv(buyerInv);
    out[priceItem] = held(buyerInv, priceItem) - priceQty;
    return {
      ok: true, error: null,
      buyerInv: out,
      priceItem: priceItem,
      sellerGets: priceQty - fee,
      treasuryGets: fee
    };
  }

  /** Display name for a resource key. Saves + wire protocol still say `gold`. */
  function dispKey(k) { return k === 'gold' ? 'silver' : k; }

  /** Human line for a deed: 'Moss & Stone — 24 tiles @ 40 silver'. Never throws. */
  function describe(deed) {
    try {
      var nm = (deed && typeof deed.name === 'string' && deed.name) || 'unnamed parcel';
      var n = (deed && Array.isArray(deed.tiles)) ? deed.tiles.length : 0;
      var price = (deed && isName(deed.priceItem) && isPosInt(deed.priceQty))
        ? (' @ ' + deed.priceQty + ' ' + dispKey(deed.priceItem)) : '';
      return nm + ' — ' + n + ' tiles' + price;
    } catch (e) { return 'a parcel deed'; }
  }

  return {
    FEE_BPS: FEE_BPS,
    FEE_DENOM: FEE_DENOM,
    MAX_DEED_TILES: MAX_DEED_TILES,
    MAX_NAME: MAX_NAME,
    MAX_QTY: MAX_QTY,
    normalizeTiles: normalizeTiles, // clean+dedupe+sort, or null.
    isContiguous: isContiguous,     // 4-neighbourhood connectivity.
    bbox: bbox,                     // bounding box + count, or null.
    cleanName: cleanName,           // bounded control-char-free name.
    validateDeed: validateDeed,     // { ok, tiles, name } or { ok:false, error }.
    feeFor: feeFor,                 // integer treasury fee for a price.
    validListing: validListing,     // { ok, error } — price shape only.
    swapDeed: swapDeed,             // atomic buyer/seller/treasury split.
    describe: describe              // human one-liner. Never throws.
  };
});
