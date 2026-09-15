/**
 * achievements.js — achievement definitions for STRATUM.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Achievements = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - Server tracks per-player stats: { kills, level, claimed, crafts, tools, maps }.
 *     All predicates tolerate malformed stats (missing/NaN/negative read as locked).
 */
(function (root, factory) {
  // UMD: Node gets module.exports, a plain <script> gets window.Achievements. Nothing else.
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Achievements = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** True for a finite integer (0 included); used to reject garbage input. */
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }

  /** Recursively freeze a value so no caller can reach into a shared table. */
  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  /**
   * Safe numeric read of a stats field: finite numbers that are >= 0 pass through,
   * everything else (missing, NaN, negative, non-number) reads as 0. Never throws.
   */
  function num(stats, key) {
    var v = stats ? stats[key] : 0;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  /** True when stats is a plain object (arrays and primitives rejected). */
  function isStatsObj(stats) {
    return !!stats && typeof stats === 'object' && !Array.isArray(stats);
  }

  /** Build a threshold predicate over one stats key; never throws, never mutates. */
  function atLeast(key, n) {
    return function (stats) {
      if (!isStatsObj(stats)) return false;
      return num(stats, key) >= n;
    };
  }

  // ======================================================================
  // achievement table — 14 entries across 6 tracks
  // ======================================================================

  var ACHIEVEMENTS = deepFreeze([
    // ---- kills (3) ----
    { id: 'first-blood', name: 'First Blood', desc: 'Slay your first foe.', tier: 0, check: atLeast('kills', 1) },
    { id: 'skirmisher', name: 'Skirmisher', desc: 'Slay 25 foes.', tier: 1, check: atLeast('kills', 25) },
    { id: 'slayer', name: 'Slayer', desc: 'Slay 100 foes.', tier: 3, title: 'Slayer', check: atLeast('kills', 100) },
    // ---- level (2) ----
    { id: 'rising', name: 'Rising', desc: 'Reach level 5.', tier: 1, check: atLeast('level', 5) },
    { id: 'ascendant', name: 'Ascendant', desc: 'Reach level 10.', tier: 3, title: 'Ascendant', check: atLeast('level', 10) },
    // ---- land claimed (2) ----
    { id: 'homesteader', name: 'Homesteader', desc: 'Claim 25 tiles on the current map.', tier: 1, check: atLeast('claimed', 25) },
    { id: 'land-baron', name: 'Land Baron', desc: 'Claim 100 tiles on the current map.', tier: 2, title: 'Land Baron', check: atLeast('claimed', 100) },
    // ---- crafts (2) ----
    { id: 'tinkerer', name: 'Tinkerer', desc: 'Complete 5 crafts.', tier: 0, check: atLeast('crafts', 5) },
    { id: 'artificer', name: 'Artificer', desc: 'Complete 25 crafts.', tier: 2, check: atLeast('crafts', 25) },
    // ---- tool tier (3) ----
    { id: 'copper-hands', name: 'Copper Hands', desc: 'Reach tool tier 1.', tier: 0, check: atLeast('tools', 1) },
    { id: 'iron-will', name: 'Iron Will', desc: 'Reach tool tier 2.', tier: 1, check: atLeast('tools', 2) },
    { id: 'master-smith', name: 'Master Smith', desc: 'Reach tool tier 3.', tier: 3, title: 'Master Smith', check: atLeast('tools', 3) },
    // ---- travel (2) ----
    { id: 'wayfarer', name: 'Wayfarer', desc: 'Visit map 1.', tier: 1, check: atLeast('maps', 1) },
    { id: 'far-wanderer', name: 'Far Wanderer', desc: 'Visit map 2.', tier: 2, title: 'Far Wanderer', check: atLeast('maps', 2) }
  ]);

  // ======================================================================
  // lookups
  // ======================================================================

  /** Achievement record for an id, or null. Never throws, never mutates. */
  function achievementById(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      if (ACHIEVEMENTS[i].id === id) return ACHIEVEMENTS[i];
    }
    return null;
  }

  /** Title string granted by an achievement id, or null when it grants none. */
  function titleFor(id) {
    var a = achievementById(id);
    return (a && typeof a.title === 'string') ? a.title : null;
  }

  /** Ids of every achievement whose check passes for these stats. Always a fresh array. */
  function unlockedIds(stats) {
    var out = [];
    if (!isStatsObj(stats)) return out;
    for (var i = 0; i < ACHIEVEMENTS.length; i++) {
      var a = ACHIEVEMENTS[i];
      var ok = false;
      try { ok = !!a.check(stats); } catch (e) { ok = false; }
      if (ok) out.push(a.id);
    }
    return out;
  }

  /**
   * Newly unlocked ids: unlocked by stats minus those already in knownIds.
   * Never throws, never mutates either argument, always returns a fresh array.
   */
  function evaluate(knownIds, stats) {
    var unlocked = unlockedIds(stats);
    var known = {};
    if (Array.isArray(knownIds)) {
      for (var i = 0; i < knownIds.length; i++) {
        if (typeof knownIds[i] === 'string') known[knownIds[i]] = true;
      }
    }
    var out = [];
    for (var j = 0; j < unlocked.length; j++) {
      if (!known[unlocked[j]]) out.push(unlocked[j]);
    }
    return out;
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    ACHIEVEMENTS: ACHIEVEMENTS,     // all 14 achievement records (frozen).
    achievementById: achievementById, // record for an id, or null.
    unlockedIds: unlockedIds,       // ids whose check passes for stats (fresh array).
    evaluate: evaluate,             // newly unlocked ids not in knownIds (fresh array).
    titleFor: titleFor              // title granted by an id, or null.
  };
});
