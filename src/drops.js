/**
 * drops.js — death drops for STRATUM: dying must cost something, but never your gear.
 *
 * WHY THIS FILE EXISTS
 *   Combat and the volatile layer can kill you, and until now a death cost nothing but
 *   time. This module is the price: on death you spill HALF (rounded down) of every raw
 *   resource you are carrying, and the spill becomes a lootable cache on the map that
 *   anyone can walk over and take. Crafted gear is bound to you and never drops, so a
 *   bad fight costs materials, not progression.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Drops = {...}` when
 *     loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Every helper returns fresh objects
 *     and NEVER mutates its arguments.
 *   - Resource names and stack ceilings mirror src/economy.js, which owns them; they are
 *     duplicated here only so this module stays dependency-free.
 *
 * Inventories are flat plain objects — the shape the server keeps in `client.inv`
 * ({ wood: 0, ore: 0, herb: 0, crystal: 0 }) with crafted item ids sitting alongside.
 * A drop is plain data, safe to JSON round-trip into the world save:
 *   { id, map, x, y, res: { wood: 3 }, at: <ms epoch>, ttlMs: 600000 }
 */
(function (root, factory) {
  // UMD: Node gets module.exports, a plain <script> gets window.Drops. Nothing else.
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Drops = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ======================================================================
  // basics
  // ======================================================================

  /** The four harvested resources, in the order the HUD shows them (mirror of economy.js). */
  var RESOURCES = deepFreeze(['wood', 'ore', 'herb', 'crystal']);

  /** Default per-resource pickup ceilings, mirroring economy.js STACK_LIMITS. */
  var STACK_LIMITS = deepFreeze({ wood: 400, ore: 400, herb: 200, crystal: 100 });

  /** Default lifetime of a drop: 10 minutes, in milliseconds. */
  var DEFAULT_TTL_MS = 600000;

  /** The world is a fixed 1024x1024 grid; coordinates are integers 0..W-1 / 0..H-1. */
  var W = 1024;

  /** World height — identical to W, named separately so call sites read clearly. */
  var H = 1024;

  /** True for a finite integer (0 included); used to reject garbage input. */
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /** True for a non-empty string; drop ids and map names must be usable as keys/labels. */
  function isName(s) { return typeof s === 'string' && s.length > 0; }

  /** Recursively freeze a value so no caller can reach into a shared table. */
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

  /** True if `key` is one of the four raw resources that can be dropped. */
  function isResource(key) { return RESOURCES.indexOf(key) !== -1; }

  /** The pickup ceiling for a resource key, from `limits` when valid else the default. */
  function limitFor(limits, key) {
    var v = limits ? limits[key] : undefined;
    return (isInt(v) && v > 0) ? v : STACK_LIMITS[key];
  }

  // ======================================================================
  // 1. what a death costs
  // ======================================================================

  /**
   * Split `inv` at the moment of death: HALF (rounded down) of each raw resource is
   * dropped where you fell, the rest stays with you. Crafted gear — every inventory key
   * that is not wood/ore/herb/crystal — is never dropped, at any amount. Zero, negative
   * and junk entries are ignored entirely.
   * Returns fresh { dropped, kept } objects; `inv` is never touched.
   */
  function dropsForDeath(inv) {
    var dropped = {}, kept = cloneInv(inv);
    for (var i = 0; i < RESOURCES.length; i++) {
      var key = RESOURCES[i];
      var amount = held(inv, key);
      var loss = Math.floor(amount / 2);
      if (loss > 0) {
        dropped[key] = loss;
        kept[key] = amount - loss;
      } else if (Object.prototype.hasOwnProperty.call(kept, key)) {
        kept[key] = amount;
      }
    }
    return { dropped: dropped, kept: kept };
  }

  // ======================================================================
  // 2. the drop record
  // ======================================================================

  /** Strip a resource bag down to its positive integer entries; null if malformed. */
  function cleanRes(res) {
    if (!res || typeof res !== 'object') return null;
    var out = {}, any = false;
    for (var k in res) {
      if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
      var v = res[k];
      if (!isInt(v) || v <= 0) continue;
      out[k] = v;
      any = true;
    }
    return any ? out : null;
  }

  /**
   * Build the loot cache left behind at (x, y) on `map`. Returns a fresh drop object, or
   * null on ANY invalid input: a non-string/empty id, a non-string/empty map, a
   * non-integer or out-of-world coordinate, a resource bag with nothing droppable in it,
   * a non-integer `now`, or a non-integer / non-positive ttl. Default TTL is 10 minutes.
   */
  function makeDrop(id, map, x, y, res, now, ttlMs) {
    if (!isName(id) || !isName(map)) return null;
    if (!isInt(x) || !isInt(y) || x < 0 || x >= W || y < 0 || y >= H) return null;
    if (!isInt(now) || now < 0) return null;
    var ttl = (ttlMs === undefined) ? DEFAULT_TTL_MS : ttlMs;
    if (!isInt(ttl) || ttl <= 0) return null;
    var bag = cleanRes(res);
    if (!bag) return null;
    return { id: id, map: map, x: x, y: y, res: bag, at: now, ttlMs: ttl };
  }

  /** Total number of resource units still sitting in a drop (0 for anything malformed). */
  function totalIn(drop) {
    if (!drop || typeof drop !== 'object' || !drop.res || typeof drop.res !== 'object') return 0;
    var n = 0;
    for (var k in drop.res) {
      if (!Object.prototype.hasOwnProperty.call(drop.res, k)) continue;
      if (isInt(drop.res[k]) && drop.res[k] > 0) n += drop.res[k];
    }
    return n;
  }

  /** True once a drop has aged past its ttl: (now - at) > ttlMs. Malformed input is expired. */
  function expired(drop, now) {
    if (!drop || typeof drop !== 'object') return true;
    if (!isInt(drop.at) || !isInt(drop.ttlMs) || !isInt(now)) return true;
    return (now - drop.at) > drop.ttlMs;
  }

  /** Display name for a resource key. Saves + wire protocol still say `gold`. */
  function dispKey(key) { return key; }

  /** A short human line for a drop: '2 wood + 1 ore', or 'an empty cache'. */
  function describe(drop) {
    if (!drop || typeof drop !== 'object' || !drop.res || typeof drop.res !== 'object') {
      return 'an empty cache';
    }
    var parts = [];
    for (var i = 0; i < RESOURCES.length; i++) {
      var key = RESOURCES[i];
      if (isInt(drop.res[key]) && drop.res[key] > 0) parts.push(drop.res[key] + ' ' + dispKey(key));
    }
    return parts.length ? parts.join(' + ') : 'an empty cache';
  }

  // ======================================================================
  // 3. pickup
  // ======================================================================

  /** Uniform pickup failure: ok:false, a reason, leftover = nothing, and inv untouched. */
  function pickupFail(inv, reason, left) {
    return { ok: false, reason: reason, inv: inv, taken: null, left: left || null };
  }

  /** A drop is only lootable if it has the fields the rest of this module reasons about. */
  function isWellFormed(drop) {
    return !!(drop && typeof drop === 'object' &&
      isName(drop.id) && isName(drop.map) &&
      isInt(drop.x) && isInt(drop.y) && isInt(drop.at) && isInt(drop.ttlMs));
  }

  /**
   * Take what fits from `drop` into `inv`. Returns { ok:true, inv (NEW), taken, left } —
   * where `taken` is what actually moved and `left` is whatever the stack ceilings forced
   * you to leave behind on the ground. Returns { ok:false, reason, inv (the argument,
   * unmodified) } with reason 'expired' | 'empty' | 'invalid'. Never throws, never mutates.
   */
  function pickup(drop, inv, now, limits) {
    if (!isWellFormed(drop) || !isInt(now)) return pickupFail(inv, 'invalid');
    if (expired(drop, now)) return pickupFail(inv, 'expired');
    if (totalIn(drop) <= 0) return pickupFail(inv, 'empty');

    var out = cloneInv(inv), taken = {}, left = {};
    for (var i = 0; i < RESOURCES.length; i++) {
      var key = RESOURCES[i];
      var avail = held(drop.res, key);
      if (avail <= 0) continue;
      var limit = limitFor(limits, key);
      var room = limit - held(inv, key);
      if (room < 0) room = 0;
      var move = avail < room ? avail : room;
      if (move > 0) {
        out[key] = held(inv, key) + move;
        taken[key] = move;
      }
      var spare = avail - move;
      if (spare > 0) left[key] = spare;
    }
    if (totalIn({ res: taken }) <= 0) return pickupFail(inv, 'empty');
    return {
      ok: true, reason: null, inv: out, taken: taken,
      left: totalIn({ res: left }) > 0 ? left : null
    };
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    // ---- constants --------------------------------------------------------
    RESOURCES: RESOURCES,                 // the four droppable raw resource names.
    STACK_LIMITS: STACK_LIMITS,           // default per-resource pickup ceilings.
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,       // default drop lifetime: 10 minutes.
    W: W,                                 // world width; x must be an integer 0..W-1.
    H: H,                                 // world height; y must be an integer 0..H-1.

    // ---- death ------------------------------------------------------------
    dropsForDeath: dropsForDeath,         // { dropped, kept }: half-floor split, gear never drops.

    // ---- drop records -----------------------------------------------------
    makeDrop: makeDrop,                   // build a loot cache, or null on any invalid input.
    expired: expired,                     // true once (now - at) > ttlMs; malformed reads expired.
    totalIn: totalIn,                     // resource units still sitting in a drop.
    describe: describe,                   // '2 wood + 1 ore', or 'an empty cache'.

    // ---- looting ----------------------------------------------------------
    pickup: pickup                        // { ok, inv (NEW), taken, left } or { ok:false, reason, inv }.
  };
});
