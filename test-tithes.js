'use strict';
/* test-tithes.js — pure unit tests for src/tithes.js (settler standing orders).
 * No server, no sockets. */
const TI = require('./src/tithes.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

check('entry-fixed-50000', TI.ENTRY === 50000);
check('entry-exported-as-ENTRY', TI.validateStart('sable', 50000, []).price === TI.ENTRY);
check('weekly-default-100', TI.WEEKLY === 100);
check('mult', TI.MULT === 1.10);
check('settlers', TI.SETTLERS.join(',') === 'sable,dray,ilo');
check('week-ms', TI.WEEK_MS === 7 * 24 * 3600 * 1000);
check('frozen', Object.isFrozen(TI.SETTLERS));
check('isSettler', TI.isSettler('dray') === true && TI.isSettler('ghost') === false && TI.isSettler(null) === false);

check('start-ok', JSON.stringify(TI.validateStart('sable', 50000, [])) ===
  JSON.stringify({ ok: true, price: 50000, error: null }));
check('start-bad-settler', TI.validateStart('ghost', 99999, []).error === 'unknown settler');
check('start-already-array', TI.validateStart('sable', 99999, ['sable']).error === 'already tithing');
check('start-already-set', TI.validateStart('ilo', 99999, new Set(['ilo'])).error === 'already tithing');
check('start-cannot-afford', TI.validateStart('sable', 49999, []).error === 'need 50000 STRATUM pending');
check('start-garbage-never-throws', (function () {
  try { return TI.validateStart(null, null, null).ok === false; } catch (e) { return false; }
})());

check('upkeep-due-after-week', TI.upkeepDue({ lastUpkeepAt: 0 }, TI.WEEK_MS + 1).due === true);
check('upkeep-not-due-fresh', TI.upkeepDue({ lastUpkeepAt: Date.now() }, Date.now()).due === false);
check('upkeep-due-bad-row', TI.upkeepDue(null, Date.now()).due === false);
check('upkeep-never-throws', (function () {
  try { TI.upkeepDue(null, null); TI.upkeepDue('x', 'y'); return true; } catch (e) { return false; }
})());

check('settle-ok', JSON.stringify(TI.settleUpkeep(500, 100)) === JSON.stringify({ ok: true, paid: 100 }));
check('settle-exact', TI.settleUpkeep(100, 100).ok === true);
check('settle-poor', TI.settleUpkeep(99, 100).ok === false);
check('settle-never-throws', (function () {
  try { TI.settleUpkeep(null, null); return true; } catch (e) { return false; }
})());

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
