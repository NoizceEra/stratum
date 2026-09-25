/**
 * landmarks.js — discoverable wonder sites: fixed world features worth finding.
 *
 * WHY THIS FILE EXISTS
 *   The world is big and mostly empty between nodes. Six named sites (two per
 *   map) give explorers a reason to walk: tap one within reach to discover it
 *   for a one-time STRATUM + XP reward. Positions are camp-style offsets from
 *   each map's spawn, resolved dry client- and server-side by the same
 *   first-dry-candidate rule, so both sides agree without any protocol.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Never throws, never mutates. Rewards are whole units.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Landmarks = api;
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

  // dx/dy from the map's spawn; the resolver picks the first dry candidate set.
  // Each site lists several candidate anchors so water never eats a wonder.
  var SITES = deepFreeze([
    { id: 'crashed-freighter', name: 'Crashed Freighter', map: 0,
      cands: [[-24, 18], [-30, 10], [-18, 26]], reward: 40, xp: 60,
      lore: 'Earth hull, Stratum soil. The colony started where she fell.' },
    { id: 'elder-tree', name: 'Elder Tree', map: 0,
      cands: [[22, -20], [28, -12], [16, -28]], reward: 25, xp: 40,
      lore: 'Older than the landing. The leaves remember rain that never came.' },
    { id: 'slag-maw', name: 'Slag Maw', map: 1,
      cands: [[-20, -22], [-28, -14], [-14, -30]], reward: 40, xp: 60,
      lore: 'The Hollow breathes here. Miners leave offerings of ore.' },
    { id: 'ember-vent', name: 'Ember Vent', map: 1,
      cands: [[24, 16], [30, 8], [18, 24]], reward: 25, xp: 40,
      lore: 'Warmth without fire. Kilns dream of this heat.' },
    { id: 'tide-altar', name: 'Tide Altar', map: 2,
      cands: [[-22, 20], [-28, 12], [-16, 28]], reward: 40, xp: 60,
      lore: 'Someone stacked these stones before us. Someone patient.' },
    { id: 'drowned-beacon', name: 'Drowned Beacon', map: 2,
      cands: [[20, -24], [26, -16], [14, -30]], reward: 25, xp: 40,
      lore: 'It still blinks. Nothing on Stratum built it. Nothing claims it.' }
  ]);

  /** Site record for an id, or null. Never throws. */
  function siteOf(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < SITES.length; i++) {
      if (SITES[i].id === id) return SITES[i];
    }
    return null;
  }

  /** Sites on a map (fresh array of the frozen rows). Never throws. */
  function sitesForMap(map) {
    var out = [];
    try {
      for (var i = 0; i < SITES.length; i++) {
        if (SITES[i].map === map) out.push(SITES[i]);
      }
    } catch (e) {}
    return out;
  }

  return {
    SITES: SITES,
    siteOf: siteOf,
    sitesForMap: sitesForMap
  };
});
