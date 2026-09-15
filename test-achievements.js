/* test-achievements.js — assertions for src/achievements.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var A = require('./src/achievements.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
function snap(v) { return JSON.stringify(v); }

// Minimal stats that should unlock each achievement (base + one bumped field).
var UNLOCK_STATS = {
  'first-blood': { kills: 1, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 0 },
  'skirmisher': { kills: 25, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 0 },
  'slayer': { kills: 100, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 0 },
  'rising': { kills: 0, level: 5, claimed: 0, crafts: 0, tools: 0, maps: 0 },
  'ascendant': { kills: 0, level: 10, claimed: 0, crafts: 0, tools: 0, maps: 0 },
  'homesteader': { kills: 0, level: 1, claimed: 25, crafts: 0, tools: 0, maps: 0 },
  'land-baron': { kills: 0, level: 1, claimed: 100, crafts: 0, tools: 0, maps: 0 },
  'tinkerer': { kills: 0, level: 1, claimed: 0, crafts: 5, tools: 0, maps: 0 },
  'artificer': { kills: 0, level: 1, claimed: 0, crafts: 25, tools: 0, maps: 0 },
  'copper-hands': { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 1, maps: 0 },
  'iron-will': { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 2, maps: 0 },
  'master-smith': { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 3, maps: 0 },
  'wayfarer': { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 1 },
  'far-wanderer': { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 2 }
};

// 1. table shape: ~14 entries, unique ids, required fields, tier 0-3, check is function.
check('count-is-14', A.ACHIEVEMENTS.length === 14);
var ids = A.ACHIEVEMENTS.map(function (a) { return a.id; });
check('ids-unique', new Set(ids).size === ids.length);
check('shape-valid', A.ACHIEVEMENTS.every(function (a) {
  return typeof a.id === 'string' && typeof a.name === 'string' &&
    typeof a.desc === 'string' && typeof a.desc === 'string' && a.desc.length > 0 &&
    Number.isInteger(a.tier) && a.tier >= 0 && a.tier <= 3 &&
    typeof a.check === 'function';
}));
var tracks = { kills: 0, level: 0, claimed: 0, crafts: 0, tools: 0, maps: 0 };
A.ACHIEVEMENTS.forEach(function (a) {
  for (var k in UNLOCK_STATS[a.id] || {}) { if (UNLOCK_STATS[a.id][k] > 0 && k !== 'level' || (k === 'level' && UNLOCK_STATS[a.id][k] > 1)) tracks[k]++; }
});
check('all-six-tracks-covered', Object.keys(tracks).every(function (k) { return tracks[k] > 0; }));

// 2. titles: at least 4 grants, titles unique strings.
var titled = A.ACHIEVEMENTS.filter(function (a) { return typeof a.title === 'string'; });
check('titles-at-least-4', titled.length >= 4);
check('titles-unique', new Set(titled.map(function (a) { return a.title; })).size === titled.length);

// 3. reachability: each achievement unlocks from its constructed stats.
Object.keys(UNLOCK_STATS).forEach(function (id) {
  var got = A.unlockedIds(UNLOCK_STATS[id]);
  check('reachable-' + id, got.indexOf(id) !== -1);
});

// 4. fresh player unlocks nothing.
var fresh = { kills: 0, level: 1, claimed: 0, crafts: 0, tools: 0, maps: 0 };
check('fresh-unlocks-nothing', A.unlockedIds(fresh).length === 0);
check('fresh-evaluate-nothing', A.evaluate([], fresh).length === 0);

// 5. lookups.
check('byId-known', A.achievementById('slayer') && A.achievementById('slayer').id === 'slayer');
check('byId-unknown-null', A.achievementById('nope') === null);
check('titleFor-known', A.titleFor('slayer') === 'Slayer');
check('titleFor-untitled-null', A.titleFor('first-blood') === null);
check('titleFor-unknown-null', A.titleFor('nope') === null);

// 6. evaluate: only-new, idempotent, no mutation.
var big = { kills: 100, level: 10, claimed: 100, crafts: 25, tools: 3, maps: 2 };
var all = A.unlockedIds(big);
check('max-stats-unlocks-all-14', all.length === 14);
var knownBefore = ['first-blood'];
var statsBefore = snap(big);
var fresh1 = A.evaluate(knownBefore, big);
check('evaluate-only-new', fresh1.indexOf('first-blood') === -1 && fresh1.length === all.length - 1);
check('evaluate-no-mutate-known', snap(knownBefore) === snap(['first-blood']));
check('evaluate-no-mutate-stats', snap(big) === statsBefore);
var again = A.evaluate(all.slice(), big);
check('evaluate-idempotent', again.length === 0);
var unlockedBefore = snap(A.unlockedIds(big));
A.evaluate([], big);
check('evaluate-no-mutate-shared-table', snap(A.unlockedIds(big)) === unlockedBefore);
var r1 = A.unlockedIds(big);
r1.push('junk');
check('unlockedIds-fresh-array', A.unlockedIds(big).indexOf('junk') === -1);

// 7. malformed stats fail clean (no throw).
[null, undefined, 42, 'x', true, [], [1, 2]].forEach(function (bad, i) {
  var okU = !throws(function () { A.unlockedIds(bad); }) && A.unlockedIds(bad).length === 0;
  var okE = !throws(function () { A.evaluate([], bad); }) && A.evaluate([], bad).length === 0;
  check('malformed-' + i + '-clean', okU && okE);
});
check('malformed-evaluate-bad-known', !throws(function () { A.evaluate(null, fresh); }) && Array.isArray(A.evaluate(null, fresh)));
check('malformed-garbage-fields', !throws(function () {
  A.unlockedIds({ kills: NaN, level: -5, claimed: 'lots', crafts: null, tools: {}, maps: Infinity });
}) && A.unlockedIds({ kills: NaN, level: -5, claimed: 'lots', crafts: null, tools: {}, maps: Infinity }).length === 0);
check('malformed-check-never-throws', A.ACHIEVEMENTS.every(function (a) {
  return !throws(function () { a.check(null); }) && a.check(null) === false;
}));

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
