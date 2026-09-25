'use strict';
/* test-dailies.js — pure unit tests for src/dailies.js. No server, no sockets. */
const D = require('./src/dailies.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// ---- defs ----
check('six-defs', D.DEFS.length === 6);
check('ids-unique', new Set(D.DEFS.map(d => d.id)).size === D.DEFS.length);
check('well-formed', D.DEFS.every(d =>
  typeof d.label === 'string' && typeof d.metric === 'string' && d.target > 0 &&
  d.reward && d.reward.stratum > 0 && d.reward.xp > 0));
check('metrics-allowed', D.DEFS.every(d => ['harvests', 'kills', 'crafts', 'travels', 'claims'].indexOf(d.metric) !== -1));
check('frozen', Object.isFrozen(D.DEFS) && Object.isFrozen(D.DEFS[0]));
check('daily-count-3', D.DAILY_COUNT === 3);

// ---- selection ----
check('three-returned', D.dailiesForDay(0).length === 3);
check('distinct', (function () {
  const ids = D.dailiesForDay(42).map(d => d.id);
  return new Set(ids).size === 3;
})());
check('deterministic', (function () {
  const a = D.dailiesForDay(123).map(d => d.id).join(',');
  const b = D.dailiesForDay(123).map(d => d.id).join(',');
  return a === b;
})());
check('different-days-differ', (function () {
  const a = D.dailiesForDay(100).map(d => d.id).join(',');
  const b = D.dailiesForDay(101).map(d => d.id).join(',');
  return a !== b;
})());
check('negative-day-safe', D.dailiesForDay(-5).length === 3);
check('garbage-day-safe', D.dailiesForDay(null).length === 3 && D.dailiesForDay('x').length === 3);

// ---- completion ----
check('completedOf-done', (function () {
  const def = D.DEFS[0];
  const r = D.completedOf(def, { harvests: 99 });
  return r.done === true && r.progress === 99 && r.target === def.target;
})());
check('completedOf-progress', (function () {
  const def = { id: 'x', label: 'x', metric: 'kills', target: 5, reward: { stratum: 1, xp: 1 } };
  const r = D.completedOf(def, { kills: 2 });
  return r.done === false && r.progress === 2 && r.target === 5;
})());
check('completedOf-garbage', (function () {
  const r = D.completedOf(null, null);
  return r.done === false && r.progress === 0 && r.target === 0;
})());
check('completedOf-missing-metric', (function () {
  const def = { id: 'x', label: 'x', metric: 'harvests', target: 10, reward: { stratum: 1, xp: 1 } };
  return D.completedOf(def, {}).done === false;
})());

// ---- summary ----
check('summary-shape', (function () {
  const s = D.summary({ harvests: 3, kills: 9, crafts: 9, travels: 1, claims: 9 }, 7);
  return Array.isArray(s.quests) && s.quests.length === 3 &&
    s.quests.every(q => typeof q.id === 'string' && q.target > 0 && q.progress >= 0 && typeof q.done === 'boolean' && q.reward);
})());
check('summary-all-done', (function () {
  const s = D.summary({ harvests: 99, kills: 99, crafts: 99, travels: 99, claims: 99 }, 7);
  return s.allDone === true;
})());
check('summary-not-done', (function () {
  const s = D.summary({}, 7);
  return s.allDone === false;
})());

// ---- day math ----
check('dayOf', D.dayOf(0) === 0 && D.dayOf(D.DAY_MS) === 1 && D.dayOf(2 * D.DAY_MS - 1) === 1);
check('isNewDay', D.isNewDay(0, D.DAY_MS) === true && D.isNewDay(0, D.DAY_MS - 1) === false && D.isNewDay(1, D.DAY_MS) === false);
check('isNewDay-garbage', D.isNewDay(null, null) === false);

// ---- purity / hygiene ----
var source = require('fs').readFileSync('./src/dailies.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('no-clock-or-random', source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('no-require-or-io', source.indexOf('require(') === -1 && source.indexOf('process.') === -1);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
