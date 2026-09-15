/**
 * quests.js — first-session quest sequence for STRATUM.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Quests = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - One active quest at a time, in order: harvest → claim → kill → craft → upgrade →
 *     travel → level. Harvest comes first so it matches harvest-before-build onboarding.
 *     Predicates tolerate malformed stats (missing/NaN/negative as 0).
 */
(function (root, factory) {
  // UMD: Node gets module.exports, a plain <script> gets window.Quests. Nothing else.
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Quests = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

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

  /** Threshold predicate over one stats key; never throws, never mutates. */
  function atLeast(key, n) {
    return function (stats) {
      if (!isStatsObj(stats)) return false;
      return num(stats, key) >= n;
    };
  }

  /** True when any of the given keys meets the threshold. */
  function anyAtLeast(keys, n) {
    return function (stats) {
      if (!isStatsObj(stats)) return false;
      for (var i = 0; i < keys.length; i++) {
        if (num(stats, keys[i]) >= n) return true;
      }
      return false;
    };
  }

  /** Safe check wrapper: never throws, always boolean. */
  function passes(quest, stats) {
    if (!quest || typeof quest.check !== 'function') return false;
    try { return !!quest.check(stats); } catch (e) { return false; }
  }

  /**
   * Normalize an optional completed set (Array, Set, or id→truthy map) into a
   * plain lookup object. Returns null when the argument is absent/unusable so
   * callers can fall back to stats checks.
   */
  function completedLookup(completedSet) {
    if (completedSet == null) return null;
    var bag = {};
    if (typeof completedSet.has === 'function' && typeof completedSet.forEach === 'function') {
      completedSet.forEach(function (id) {
        if (typeof id === 'string') bag[id] = true;
      });
      return bag;
    }
    if (Array.isArray(completedSet)) {
      for (var i = 0; i < completedSet.length; i++) {
        if (typeof completedSet[i] === 'string') bag[completedSet[i]] = true;
      }
      return bag;
    }
    if (typeof completedSet === 'object') {
      for (var k in completedSet) {
        if (Object.prototype.hasOwnProperty.call(completedSet, k) && completedSet[k]) bag[k] = true;
      }
      return bag;
    }
    return null;
  }

  // ======================================================================
  // quest table — 7 first-session steps, one active at a time
  // ======================================================================

  var QUESTS = deepFreeze([
    {
      id: 'harvest',
      title: 'First Harvest',
      hint: 'Walk to a tree or ore seam and LMB to harvest.',
      check: atLeast('harvests', 1)
    },
    {
      id: 'claim',
      title: 'Claim Land',
      hint: 'LMB on empty ground to claim a tile — it is yours forever.',
      check: atLeast('claimed', 1)
    },
    {
      id: 'kill',
      title: 'First Kill',
      hint: 'Find a beast and defeat it with LMB.',
      check: atLeast('kills', 1)
    },
    {
      id: 'craft',
      title: 'Open Craft',
      hint: 'Press C to open the craft menu.',
      check: anyAtLeast(['craftOpens', 'crafts'], 1)
    },
    {
      id: 'upgrade',
      title: 'Upgrade Tools',
      hint: 'In craft, buy Copper Tools (3 wood + 2 ore).',
      check: atLeast('tools', 1)
    },
    {
      id: 'travel',
      title: 'Travel Onward',
      hint: 'Press T and travel to another map.',
      check: anyAtLeast(['mapsVisited', 'maps'], 1)
    },
    {
      id: 'level',
      title: 'Level Up',
      hint: 'Keep fighting until you reach level 2.',
      check: atLeast('level', 2)
    }
  ]);

  // ======================================================================
  // lookups / progression
  // ======================================================================

  /** Quest record for an id, or null. Never throws, never mutates. */
  function questById(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < QUESTS.length; i++) {
      if (QUESTS[i].id === id) return QUESTS[i];
    }
    return null;
  }

  /**
   * Ids of quests completed so far, in order. Stops at the first failing check
   * so the sequence stays one-active-at-a-time. Always a fresh array.
   */
  function completedFrom(stats) {
    var out = [];
    if (!isStatsObj(stats)) return out;
    for (var i = 0; i < QUESTS.length; i++) {
      if (!passes(QUESTS[i], stats)) break;
      out.push(QUESTS[i].id);
    }
    return out;
  }

  /**
   * Completed quest ids for these stats (sequential prefix). Same as
   * completedFrom; kept as evaluate(stats) for the public API surface.
   * When called as evaluate(knownIds, stats), returns only ids not already known.
   */
  function evaluate(statsOrKnown, maybeStats) {
    var knownIds = null;
    var stats = statsOrKnown;
    if (maybeStats !== undefined) {
      knownIds = statsOrKnown;
      stats = maybeStats;
    }
    var done = completedFrom(stats);
    if (!Array.isArray(knownIds)) return done;
    var known = {};
    for (var i = 0; i < knownIds.length; i++) {
      if (typeof knownIds[i] === 'string') known[knownIds[i]] = true;
    }
    var out = [];
    for (var j = 0; j < done.length; j++) {
      if (!known[done[j]]) out.push(done[j]);
    }
    return out;
  }

  /**
   * First incomplete quest, or null when the sequence is finished.
   * If completedSet is provided (Array/Set/map), incompleteness is membership
   * in that set; otherwise stats checks drive progress.
   */
  function activeQuest(stats, completedSet) {
    var bag = completedLookup(completedSet);
    for (var i = 0; i < QUESTS.length; i++) {
      var q = QUESTS[i];
      var done = (bag !== null) ? !!bag[q.id] : passes(q, stats);
      if (!done) return q;
    }
    return null;
  }

  /** True when every quest in the sequence is complete for these stats. */
  function isComplete(stats) {
    return completedFrom(stats).length === QUESTS.length;
  }

  /**
   * Progress snapshot for HUD wiring.
   * { done, total, active, remaining } — active is the quest record or null;
   * remaining is a fresh array of incomplete ids in order.
   */
  function progress(stats) {
    var doneIds = completedFrom(stats);
    var done = doneIds.length;
    var total = QUESTS.length;
    var active = done < total ? QUESTS[done] : null;
    var remaining = [];
    for (var i = done; i < total; i++) remaining.push(QUESTS[i].id);
    return { done: done, total: total, active: active, remaining: remaining };
  }

  /** Hint string for the active quest, or '' when the sequence is finished. */
  function hintFor(stats) {
    var q = activeQuest(stats);
    return (q && typeof q.hint === 'string') ? q.hint : '';
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    QUESTS: QUESTS,                 // all 7 quest records (frozen).
    questById: questById,           // record for an id, or null.
    activeQuest: activeQuest,       // first incomplete quest, or null.
    progress: progress,             // { done, total, active, remaining }.
    evaluate: evaluate,             // completed ids (or newly completed vs knownIds).
    completedFrom: completedFrom,   // sequential completed ids for stats.
    isComplete: isComplete,         // true when all 7 are done.
    hintFor: hintFor                // active hint string for HUD, or ''.
  };
});
