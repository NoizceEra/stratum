'use strict';
/* test-landmarks.js — pure unit tests for public/landmarks.js (shared with the
 * browser, like quests.js/settlers.js). PASS/FAIL per case, non-zero exit. */
const L = require('./public/landmarks.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

check('six-sites', L.SITES.length === 6);
check('two-per-map', L.sitesForMap(0).length === 2 && L.sitesForMap(1).length === 2 && L.sitesForMap(2).length === 2);
check('ids-unique', new Set(L.SITES.map(s => s.id)).size === 6);
check('frozen', Object.isFrozen(L.SITES) && Object.isFrozen(L.SITES[0]));
check('siteOf', L.siteOf('slag-maw').name === 'Slag Maw');
check('siteOf-unknown', L.siteOf('nope') === null && L.siteOf(null) === null);
check('rewards-positive', L.SITES.every(s => s.reward > 0 && s.xp > 0));
check('lore-present', L.SITES.every(s => typeof s.lore === 'string' && s.lore.length > 10));
check('cands-present', L.SITES.every(s => Array.isArray(s.cands) && s.cands.length >= 2));
check('sitesForMap-garbage', L.sitesForMap(99).length === 0 && L.sitesForMap(null).length === 0);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
