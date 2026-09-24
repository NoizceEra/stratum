/* test-settlers.js — assertions for public/settlers.js (shared with the browser, like quests.js). PASS/FAIL per case, non-zero exit on failure. */
'use strict';
const S = require('./public/settlers.js');

let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---- roster ----
check('three-settlers', S.SETTLERS.length === 3);
check('ids', S.SETTLERS.map(s => s.id).join(',') === 'sable,dray,ilo');
check('all-map-0', S.SETTLERS.every(s => s.map === 0));
check('frozen', Object.isFrozen(S.SETTLERS) && Object.isFrozen(S.SETTLERS[0]));
check('camp-spots', Array.isArray(S.CAMP_SPOTS.tents) && S.CAMP_SPOTS.tents.length === 3);
check('settlerById', S.settlerById('sable').name === 'SABLE');
check('settlerById-unknown', S.settlerById('nope') === null);
check('settlerById-garbage', S.settlerById(null) === null && S.settlerById(42) === null);
check('isAction', S.isAction('craft') === true && S.isAction('dance') === false);

// ---- talk shape ----
const t0 = S.talk('sable', {});
check('talk-shape', t0 && t0.name === 'SABLE' && typeof t0.line === 'string' && t0.line.length > 0 && Array.isArray(t0.actions) && t0.actions.length === 3);
check('talk-actions-legal', t0.actions.every(a => S.isAction(a.do)));
check('talk-unknown-null', S.talk('ghost', {}) === null);
check('talk-garbage-ctx', (function () {
  const t = S.talk('ilo', null);
  return t && t.line.length > 0;
})());
check('talk-garbage-ctx-2', (function () {
  const t = S.talk('dray', { activeQuestId: 42, tokenPending: 'lots' });
  return t && t.line.length > 0;
})());
check('talk-fresh-object', S.talk('sable', {}) !== S.talk('sable', {}));

// ---- quest reactivity ----
const QUESTS = ['harvest', 'claim', 'kill', 'craft', 'upgrade', 'travel', 'level'];
check('sable-per-quest-unique', (function () {
  const lines = QUESTS.map(q => S.talk('sable', { activeQuestId: q }).line);
  return new Set(lines).size === QUESTS.length;
})());
check('sable-complete', S.talk('sable', { activeQuestId: null, done: 7, total: 7 }).line.indexOf('whole first week') >= 0);
check('dray-craft', S.talk('dray', { activeQuestId: 'craft' }).line.indexOf('Fabricator') >= 0);
check('dray-claim', S.talk('dray', { activeQuestId: 'claim' }).line.indexOf('Claim land first') >= 0);
check('dray-pending', S.talk('dray', { tokenPending: 60 }).line.indexOf('Ilo') >= 0);
check('ilo-heavy', S.talk('ilo', { tokenPending: 80 }).line.indexOf('80 STRATUM') >= 0);
check('ilo-small', S.talk('ilo', { tokenPending: 5 }).line.indexOf('5 STRATUM') >= 0);
check('ilo-empty', S.talk('ilo', {}).line.indexOf('Archivist Ilo') >= 0);

// ---- questAction ----
check('questAction-craft', S.questAction('craft') === 'craft' && S.questAction('upgrade') === 'craft');
check('questAction-travel', S.questAction('travel') === 'travel');
check('questAction-kill', S.questAction('kill') === 'map' && S.questAction('level') === 'map');
check('questAction-default', S.questAction('harvest') === 'close' && S.questAction(null) === 'close' && S.questAction('nope') === 'close');
check('sable-first-button-matches', (function () {
  const t = S.talk('sable', { activeQuestId: 'travel' });
  return t.actions[0].do === 'travel';
})());

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
