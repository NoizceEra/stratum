/**
 * idle.js — passive idle structures for STRATUM's cozy pivot (ROADMAP_COZY.md, Phase 2).
 *
 * WHY THIS FILE EXISTS
 *   A structure converts time into resources whether anyone is watching or not. The
 *   efficient way to do that — and the way every real idle game does it — is to NOT
 *   simulate anything while nobody looks. A structure just remembers when it was last
 *   collected; the yield sitting in it right now is a pure function of elapsed wall-clock
 *   time, computed lazily whenever someone actually asks (a view, a collect). Nothing
 *   ticks in the background, so the server pays zero ongoing cost for every structure
 *   belonging to a player who isn't even online.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Idle = {...}` when
 *     loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Every helper returns fresh objects
 *     and NEVER mutates its arguments.
 *   - A structure record is plain data, safe to JSON round-trip into the world save:
 *       { id, kind, map, x, y, owner, builtAt, lastCollectedAt }
 *     The accrued yield is NEVER stored — it is always recomputed from lastCollectedAt.
 *
 * NOT WIRED YET. This module has no opinion about server.js, world.js, sockets, or
 * SQLite. It is pure math + pure data, exactly like src/economy.js and src/drops.js
 * were before their own integration pass — see ROADMAP_COZY.md's phased build order.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Idle = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ======================================================================
  // basics
  // ======================================================================

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  function cloneInv(inv) {
    var out = {};
    if (inv && typeof inv === 'object') {
      for (var k in inv) if (Object.prototype.hasOwnProperty.call(inv, k)) out[k] = inv[k];
    }
    return out;
  }

  function held(inv, key) {
    var v = inv ? inv[key] : 0;
    return (isInt(v) && v > 0) ? v : 0;
  }

  // ======================================================================
  // 1. structure catalog — what can be built, what it costs, what it makes
  // ======================================================================

  /**
   * Every structure: build cost (raw resources, same shape as economy.js MATERIAL_COSTS),
   * the tool tier that unlocks it (mirrors economy.js TOOL_TIERS gating), what resource it
   * produces, how fast (units per millisecond, so the math never needs a "per hour" step),
   * and its storage capacity (accrual simply stops once full — no loss, nothing to babysit).
   */
  var STRUCTURES = deepFreeze({
    apiary: {
      id: 'apiary', name: 'apiary', tier: 0,
      cost: { wood: 6, herb: 3 },
      produces: 'honey', ratePerMs: 1 / (45 * 1000), capacity: 20      // ~1 honey / 45s, caps at 20
    },
    kiln: {
      id: 'kiln', name: 'kiln', tier: 1,
      cost: { wood: 4, ore: 6 },
      produces: 'refined_ore', ratePerMs: 1 / (60 * 1000), capacity: 16 // ~1 refined ore / 60s, caps at 16
    },
    still: {
      id: 'still', name: 'still', tier: 1,
      cost: { wood: 5, herb: 4 },
      produces: 'tonic', ratePerMs: 1 / (90 * 1000), capacity: 10       // ~1 tonic / 90s, caps at 10
    },
    smoker: {
      id: 'smoker', name: 'smoker', tier: 2,
      cost: { wood: 8, ore: 2 },
      produces: 'charcoal', ratePerMs: 1 / (40 * 1000), capacity: 24    // ~1 charcoal / 40s, caps at 24
    }
  });

  /** The structure definition for a kind id, or null. */
  function structureOf(kind) {
    return Object.prototype.hasOwnProperty.call(STRUCTURES, kind) ? STRUCTURES[kind] : null;
  }

  /** Every structure kind unlocked at tool `tier` (its own tier and below); [] if bogus. */
  function structuresForTier(tier) {
    if (!isInt(tier)) return [];
    var out = [];
    for (var k in STRUCTURES) if (STRUCTURES[k].tier <= tier) out.push(STRUCTURES[k]);
    return out;
  }

  /** The resource cost of building `kind`, as a fresh object, or null for an unknown kind. */
  function buildCost(kind) {
    var d = structureOf(kind);
    if (!d) return null;
    var out = {};
    for (var k in d.cost) out[k] = d.cost[k];
    return out;
  }

  // ======================================================================
  // 2. the structure record + accrual math — the whole point of this file
  // ======================================================================

  /**
   * A fresh structure record, just built. `now` is the caller's clock (never Date.now()
   * inside this module). Returns null for an unknown kind or non-finite coordinates.
   */
  function makeStructure(id, kind, map, x, y, owner, now) {
    var d = structureOf(kind);
    if (!d) return null;
    if (typeof id !== 'string' || !id) return null;
    if (!isInt(map) || !isInt(x) || !isInt(y)) return null;
    if (typeof owner !== 'string' || !owner) return null;
    if (!isNum(now)) return null;
    return { id: id, kind: kind, map: map, x: x, y: y, owner: owner, builtAt: now, lastCollectedAt: now };
  }

  /**
   * How much has accrued since last collection, clamped to capacity. Pure: reading this
   * twice with the same `now` gives the same answer, and never mutates `struct`.
   * Returns 0 for a malformed structure or an unknown kind (never throws, never negative).
   */
  function accrued(struct, now) {
    if (!struct || typeof struct !== 'object') return 0;
    var d = structureOf(struct.kind);
    if (!d) return 0;
    if (!isNum(now) || !isNum(struct.lastCollectedAt)) return 0;
    var elapsed = Math.max(0, now - struct.lastCollectedAt);
    var raw = elapsed * d.ratePerMs;
    return Math.min(d.capacity, Math.max(0, Math.floor(raw)));
  }

  /** True once a structure's accrual has hit its capacity and further waiting adds nothing. */
  function isFull(struct, now) {
    var d = structureOf(struct && struct.kind);
    if (!d) return false;
    return accrued(struct, now) >= d.capacity;
  }

  /**
   * Collect: grants `accrued(struct, now)` of the structure's resource into `inv`, and
   * returns a NEW structure record with `lastCollectedAt` advanced to `now` (so the whole
   * elapsed window is consumed, not just the capped/collected portion — a structure that
   * overflowed while capped does not "remember" the overflow, exactly like a harvest node
   * gives its full yield and resets, never partial-credits idle time it couldn't store).
   *
   * Returns { struct, inv, gained, resource } — `struct`/`inv` are fresh objects; the
   * caller's arguments are never mutated. `gained` is 0 (a no-op collect) when nothing had
   * accrued yet; that is not an error, just an empty collection.
   */
  function collect(struct, inv, now) {
    var d = structureOf(struct && struct.kind);
    if (!d) return { struct: struct, inv: cloneInv(inv), gained: 0, resource: null };
    var gained = accrued(struct, now);
    var nextInv = cloneInv(inv);
    nextInv[d.produces] = held(nextInv, d.produces) + gained;
    var nextStruct = {
      id: struct.id, kind: struct.kind, map: struct.map, x: struct.x, y: struct.y,
      owner: struct.owner, builtAt: struct.builtAt, lastCollectedAt: now
    };
    return { struct: nextStruct, inv: nextInv, gained: gained, resource: d.produces };
  }

  /** Human-readable one-liner for a HUD/tooltip: "apiary — 6 / 20 honey". Never throws. */
  function describe(struct, now) {
    var d = structureOf(struct && struct.kind);
    if (!d) return 'unknown structure';
    return d.name + ' — ' + accrued(struct, now) + ' / ' + d.capacity + ' ' + d.produces;
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    STRUCTURES: STRUCTURES,
    structureOf: structureOf,
    structuresForTier: structuresForTier,
    buildCost: buildCost,
    makeStructure: makeStructure,
    accrued: accrued,
    isFull: isFull,
    collect: collect,
    describe: describe
  };
});
