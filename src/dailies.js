/**
 * dailies.js — rotating daily objectives for STRATUM.
 *
 * WHY THIS FILE EXISTS
 *   The first-session quest chain (public/quests.js) onboards; dailies retain.
 *   Three objectives per real-world day, chosen deterministically from the day
 *   number, so every player gets the same three and the same day never changes.
 *   Rewards are modest (a few STRATUM + XP) — a reason to log in, not a faucet.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `day`/`now` argument. Never throws, never mutates.
 *   - Metric ids mirror public/quests.js's stats vocabulary so server wiring is a
 *     straight map onto the existing questStats() shape.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Dailies = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  var DAY_MS = 24 * 3600 * 1000;
  var DAILY_COUNT = 3;

  var DEFS = deepFreeze([
    { id: 'extract', label: 'Extract 20', metric: 'harvests', target: 20, reward: { stratum: 10, xp: 10 } },
    { id: 'cull', label: 'Cull 5', metric: 'kills', target: 5, reward: { stratum: 15, xp: 15 } },
    { id: 'fabricate', label: 'Fabricate 5', metric: 'crafts', target: 5, reward: { stratum: 10, xp: 10 } },
    { id: 'voyage', label: 'Voyage 1', metric: 'travels', target: 1, reward: { stratum: 25, xp: 20 } },
    { id: 'stake', label: 'Stake 3', metric: 'claims', target: 3, reward: { stratum: 15, xp: 10 } },
    { id: 'prospect', label: 'Prospect 15', metric: 'harvests', target: 15, reward: { stratum: 5, xp: 5 } }
  ]);

  /** Small deterministic integer hash (xorshift-mul), never negative. */
  function hashDay(day) {
    var x = (day | 0) ^ 0x9e3779b9;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    x ^= x >>> 16;
    return x < 0 ? -x : x;
  }

  /** Fresh array of exactly DAILY_COUNT distinct defs for a day. Deterministic. */
  function dailiesForDay(day) {
    try {
      var d = (typeof day === 'number' && isFinite(day)) ? Math.floor(day) : 0;
      var seed = hashDay(d);
      var out = [];
      var used = {};
      var n = DEFS.length;
      if (n === 0) return out;
      var guard = 0;
      while (out.length < DAILY_COUNT && guard < n * 4) {
        guard++;
        seed = Math.imul(seed ^ (seed >>> 15), 0x27d4eb2d);
        var idx = ((seed >>> 0) % n);
        var def = DEFS[idx];
        if (used[def.id]) continue;
        used[def.id] = true;
        out.push(def);
      }
      return out;
    } catch (e) { return []; }
  }

  function num(stats, key) {
    var v = stats ? stats[key] : 0;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
  }

  /** Progress for one def against stats: { done, progress, target }. Never throws. */
  function completedOf(def, stats) {
    try {
      if (!def || typeof def !== 'object') return { done: false, progress: 0, target: 0 };
      var target = (typeof def.target === 'number' && def.target > 0) ? Math.floor(def.target) : 1;
      var progress = num(stats, def.metric);
      return { done: progress >= target, progress: progress, target: target };
    } catch (e) { return { done: false, progress: 0, target: 0 }; }
  }

  /**
   * Full summary for a day: the three defs enriched with live progress.
   * Returns { quests:[...], allDone }. Never throws; garbage degrades to empties.
   */
  function summary(stats, day) {
    try {
      var defs = dailiesForDay(day);
      var quests = [];
      var allDone = defs.length > 0;
      for (var i = 0; i < defs.length; i++) {
        var c = completedOf(defs[i], stats);
        if (!c.done) allDone = false;
        quests.push({
          id: defs[i].id, label: defs[i].label, metric: defs[i].metric,
          target: c.target, progress: c.progress, done: c.done, reward: defs[i].reward
        });
      }
      return { quests: quests, allDone: allDone };
    } catch (e) { return { quests: [], allDone: false }; }
  }

  /** Day number (floor of epoch days) for a ms timestamp. Never throws. */
  function dayOf(now) {
    try {
      return (typeof now === 'number' && isFinite(now)) ? Math.floor(now / DAY_MS) : 0;
    } catch (e) { return 0; }
  }

  /** True when a new real-world day has begun since lastDay. Never throws. */
  function isNewDay(lastDay, now) {
    try {
      var cur = dayOf(now);
      var last = (typeof lastDay === 'number' && isFinite(lastDay)) ? Math.floor(lastDay) : 0;
      return cur !== last;
    } catch (e) { return false; }
  }

  return {
    DAY_MS: DAY_MS,
    DAILY_COUNT: DAILY_COUNT,
    DEFS: DEFS,
    dailiesForDay: dailiesForDay,
    completedOf: completedOf,
    summary: summary,
    dayOf: dayOf,
    isNewDay: isNewDay
  };
});
