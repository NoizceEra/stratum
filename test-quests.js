/* test-quests.js — assertions for public/quests.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var Q = require('./public/quests.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
function snap(v) { return JSON.stringify(v); }

var EXPECTED_IDS = ['harvest', 'claim', 'kill', 'craft', 'upgrade', 'travel', 'level'];

// Minimal stats that complete each quest in isolation (used for reachability).
var UNLOCK_STATS = {
  harvest: { harvests: 1 },
  claim: { claimed: 1 },
  kill: { kills: 1 },
  craft: { crafts: 1 },
  upgrade: { tools: 1 },
  travel: { maps: 1 },
  level: { level: 2 }
};

// Stats that complete the full prefix through a given quest id.
function prefixThrough(id) {
  var s = { claimed: 0, harvests: 0, kills: 0, crafts: 0, craftOpens: 0, tools: 0, maps: 0, mapsVisited: 0, level: 1 };
  for (var i = 0; i < EXPECTED_IDS.length; i++) {
    var qid = EXPECTED_IDS[i];
    if (qid === 'harvest') s.harvests = 1;
    if (qid === 'claim') s.claimed = 1;
    if (qid === 'kill') s.kills = 1;
    if (qid === 'craft') s.crafts = 1;
    if (qid === 'upgrade') s.tools = 1;
    if (qid === 'travel') s.maps = 1;
    if (qid === 'level') s.level = 2;
    if (qid === id) break;
  }
  return s;
}

// 1. table shape
check('count-is-7', Q.QUESTS.length === 7);
var ids = Q.QUESTS.map(function (q) { return q.id; });
check('ids-match-roadmap', snap(ids) === snap(EXPECTED_IDS));
check('ids-unique', new Set(ids).size === ids.length);
check('shape-valid', Q.QUESTS.every(function (q) {
  return typeof q.id === 'string' && typeof q.title === 'string' && q.title.length > 0 &&
    typeof q.hint === 'string' && q.hint.length > 0 && typeof q.check === 'function';
}));
check('quests-frozen', Object.isFrozen(Q.QUESTS));

// 2. lookups
check('byId-known', Q.questById('kill') && Q.questById('kill').id === 'kill');
check('byId-unknown-null', Q.questById('nope') === null);
check('byId-nonstring-null', Q.questById(42) === null);

// 3. fresh player
var fresh = { claimed: 0, harvests: 0, kills: 0, crafts: 0, tools: 0, maps: 0, level: 1 };
check('fresh-completed-empty', Q.completedFrom(fresh).length === 0);
check('fresh-evaluate-empty', Q.evaluate(fresh).length === 0);
check('fresh-active-is-harvest', Q.activeQuest(fresh) && Q.activeQuest(fresh).id === 'harvest');
check('fresh-not-complete', Q.isComplete(fresh) === false);
check('fresh-hint-is-harvest', Q.hintFor(fresh) === Q.questById('harvest').hint);
check('fresh-progress', (function () {
  var p = Q.progress(fresh);
  return p.done === 0 && p.total === 7 && p.active && p.active.id === 'harvest' &&
    snap(p.remaining) === snap(EXPECTED_IDS);
})());

// 4. each check reachable in isolation
Object.keys(UNLOCK_STATS).forEach(function (id) {
  var q = Q.questById(id);
  check('reachable-check-' + id, q.check(UNLOCK_STATS[id]) === true);
});
check('craft-opens-also-counts', Q.questById('craft').check({ craftOpens: 1 }) === true);
check('travel-mapsVisited-also-counts', Q.questById('travel').check({ mapsVisited: 1 }) === true);

// 5. sequential completion: later stats alone do not skip ahead
check('kills-alone-still-on-harvest', Q.activeQuest({ kills: 5 }).id === 'harvest');
check('kills-alone-completed-empty', Q.completedFrom({ kills: 5 }).length === 0);

// 6. prefix progress through each step
EXPECTED_IDS.forEach(function (id, idx) {
  var s = prefixThrough(id);
  var done = Q.completedFrom(s);
  check('prefix-done-' + id, done.length === idx + 1 && done[done.length - 1] === id);
  if (idx < EXPECTED_IDS.length - 1) {
    var next = EXPECTED_IDS[idx + 1];
    check('prefix-active-after-' + id, Q.activeQuest(s).id === next);
    check('prefix-hint-after-' + id, Q.hintFor(s) === Q.questById(next).hint);
    check('prefix-not-complete-after-' + id, Q.isComplete(s) === false);
  } else {
    check('prefix-all-done-active-null', Q.activeQuest(s) === null);
    check('prefix-all-done-hint-empty', Q.hintFor(s) === '');
    check('prefix-all-done-isComplete', Q.isComplete(s) === true);
  }
});

// 7. progress object shape + remaining
var mid = prefixThrough('kill');
var midP = Q.progress(mid);
check('progress-mid-done', midP.done === 3);
check('progress-mid-total', midP.total === 7);
check('progress-mid-active', midP.active && midP.active.id === 'craft');
check('progress-mid-remaining', snap(midP.remaining) === snap(['craft', 'upgrade', 'travel', 'level']));
check('progress-returns-fresh-remaining', (function () {
  midP.remaining.push('junk');
  return Q.progress(mid).remaining.indexOf('junk') === -1;
})());

// 8. evaluate: default + knownIds form, no mutation
var full = prefixThrough('level');
var all = Q.completedFrom(full);
check('max-stats-completes-all-7', all.length === 7);
check('evaluate-matches-completedFrom', snap(Q.evaluate(full)) === snap(all));
var knownBefore = ['claim', 'harvest'];
var statsBefore = snap(full);
var knownSnap = snap(knownBefore);
var freshNew = Q.evaluate(knownBefore, full);
check('evaluate-only-new', freshNew.indexOf('claim') === -1 && freshNew.indexOf('harvest') === -1 &&
  freshNew.length === all.length - 2);
check('evaluate-no-mutate-known', snap(knownBefore) === knownSnap);
check('evaluate-no-mutate-stats', snap(full) === statsBefore);
check('evaluate-idempotent', Q.evaluate(all.slice(), full).length === 0);

// 9. activeQuest with completedSet (array / Set / map)
check('active-with-empty-array', Q.activeQuest(fresh, []).id === 'harvest');
check('active-with-array-prefix', Q.activeQuest(fresh, ['harvest', 'claim']).id === 'kill');
check('active-with-set', Q.activeQuest(fresh, new Set(['harvest', 'claim', 'kill', 'craft', 'upgrade', 'travel'])).id === 'level');
check('active-with-map', Q.activeQuest(fresh, { harvest: true, claim: true }).id === 'kill');
check('active-with-full-array-null', Q.activeQuest(fresh, EXPECTED_IDS.slice()) === null);
check('completedSet-ignores-stats', Q.activeQuest({ harvests: 0 }, ['harvest']).id === 'claim');

// 10. malformed stats fail clean (no throw)
[null, undefined, 42, 'x', true, [], [1, 2]].forEach(function (bad, i) {
  var okC = !throws(function () { Q.completedFrom(bad); }) && Q.completedFrom(bad).length === 0;
  var okE = !throws(function () { Q.evaluate(bad); }) && Q.evaluate(bad).length === 0;
  var okA = !throws(function () { Q.activeQuest(bad); }) && Q.activeQuest(bad) && Q.activeQuest(bad).id === 'harvest';
  var okI = !throws(function () { Q.isComplete(bad); }) && Q.isComplete(bad) === false;
  var okH = !throws(function () { Q.hintFor(bad); }) && typeof Q.hintFor(bad) === 'string';
  var okP = !throws(function () { Q.progress(bad); }) && Q.progress(bad).done === 0;
  check('malformed-' + i + '-clean', okC && okE && okA && okI && okH && okP);
});
check('malformed-garbage-fields', !throws(function () {
  Q.completedFrom({ claimed: NaN, harvests: -5, kills: 'lots', crafts: null, tools: {}, maps: Infinity, level: 0 });
}) && Q.completedFrom({ claimed: NaN, harvests: -5, kills: 'lots', crafts: null, tools: {}, maps: Infinity, level: 0 }).length === 0);
check('malformed-check-never-throws', Q.QUESTS.every(function (q) {
  return !throws(function () { q.check(null); }) && q.check(null) === false;
}));
check('malformed-evaluate-bad-known', !throws(function () { Q.evaluate(null, fresh); }) &&
  Array.isArray(Q.evaluate(null, fresh)));

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
