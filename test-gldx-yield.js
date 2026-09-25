/* test-gldx-yield.js — play-to-GLDX claim math. */
'use strict';
var G = require('./src/gldx-yield.js');
var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

check('harvest-base', G.creditFor('harvest', 1) === 100);
check('harvest-hold-2x', G.creditFor('harvest', 2) === 200);
check('harvest-no-penalty', G.creditFor('harvest', 0.5) === 100);
check('collect-pays-nothing', G.creditFor('collect', 2) === 0);
check('kill-adds-xp', G.creditFor('kill', 1, { xp: 25 }) === 175);
check('craft-base', G.creditFor('craft', 1.25) === 187);
check('earmark-half-treasury', G.earmarkOf(200) === 100);
check('earmark-odd', G.earmarkOf(5) === 2);
check('earmark-bad', G.earmarkOf(-1) === 0);

var split = G.allocate([
  { key: 'a', pending: 100, payable: 0 },
  { key: 'b', pending: 300, payable: 0 }
], 200);
check('allocate-moved', split.moved === 200);
check('allocate-a', split.rows[0].payable === 50 && split.rows[0].pending === 50);
check('allocate-b', split.rows[1].payable === 150 && split.rows[1].pending === 150);

var capped = G.allocate([
  { key: 'a', pending: 40, payable: 10 }
], 10);
check('allocate-respects-reserved', capped.moved === 0 && capped.rows[0].payable === 10);

var exact = G.allocate([{ key: 'a', pending: 5, payable: 0 }], 100);
check('allocate-not-over-claim', exact.moved === 5 && exact.rows[0].pending === 0 && exact.rows[0].payable === 5);

check('format-small', G.format(100) === '0.000001');
check('format-whole', G.format(100000000) === '1');
check('mint', G.GLDX_MINT === 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re');

if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('gldx-yield ok');
