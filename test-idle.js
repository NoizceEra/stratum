/* test-idle.js — assertions for src/idle.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var I = require('./src/idle.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function snap(v) { return JSON.stringify(v); }
function deep(a, b) { return snap(a) === snap(b); }

// ---------------------------------------------------------------- catalog
check('apiary-exists', !!I.structureOf('apiary'));
check('unknown-kind-null', I.structureOf('nope') === null);
check('tier0-includes-apiary', I.structuresForTier(0).some(function (s) { return s.id === 'apiary'; }));
check('tier0-excludes-kiln', !I.structuresForTier(0).some(function (s) { return s.id === 'kiln'; }));
check('tier1-includes-kiln-and-still', I.structuresForTier(1).length >= 3);
check('buildCost-apiary', deep(I.buildCost('apiary'), { wood: 6, herb: 3 }));
check('buildCost-unknown-null', I.buildCost('nope') === null);

// buildCost must never hand back a live reference into the frozen table
var c1 = I.buildCost('apiary'); c1.wood = 999;
check('buildCost-returns-fresh-object', I.buildCost('apiary').wood === 6);

// ---------------------------------------------------------------- makeStructure
var s = I.makeStructure('s1', 'apiary', 0, 12, 34, 'player-key', 1000);
check('makeStructure-basic-fields',
  s.id === 's1' && s.kind === 'apiary' && s.map === 0 && s.x === 12 && s.y === 34 && s.owner === 'player-key');
check('makeStructure-timestamps', s.builtAt === 1000 && s.lastCollectedAt === 1000);
check('makeStructure-unknown-kind-null', I.makeStructure('s2', 'nope', 0, 0, 0, 'k', 1000) === null);
check('makeStructure-bad-coords-null', I.makeStructure('s3', 'apiary', 0, NaN, 0, 'k', 1000) === null);
check('makeStructure-no-owner-null', I.makeStructure('s4', 'apiary', 0, 0, 0, '', 1000) === null);
check('makeStructure-no-now-null', I.makeStructure('s5', 'apiary', 0, 0, 0, 'k', NaN) === null);

// ---------------------------------------------------------------- accrual math
// apiary: 1 / 45000ms, capacity 20
check('accrued-zero-at-build-time', I.accrued(s, 1000) === 0);
check('accrued-partial-tick', I.accrued(s, 1000 + 44999) === 0);          // not yet a whole unit
check('accrued-one-unit', I.accrued(s, 1000 + 45000) === 1);
check('accrued-several-units', I.accrued(s, 1000 + 45000 * 5) === 5);
check('accrued-caps-at-capacity', I.accrued(s, 1000 + 45000 * 9999) === 20);
check('accrued-never-negative-on-weird-clock', I.accrued(s, 500) === 0);   // now before lastCollectedAt
check('accrued-malformed-struct-zero', I.accrued(null, 2000) === 0);
check('accrued-malformed-now-zero', I.accrued(s, 'soon') === 0);
check('accrued-unknown-kind-zero', I.accrued({ kind: 'nope', lastCollectedAt: 0 }, 1000) === 0);

check('isFull-false-when-partial', I.isFull(s, 1000 + 45000 * 5) === false);
check('isFull-true-at-capacity', I.isFull(s, 1000 + 45000 * 25) === true);

// ---------------------------------------------------------------- collect
var inv0 = { wood: 2, honey: 3 };
var res = I.collect(s, inv0, 1000 + 45000 * 5);   // 5 honey accrued
check('collect-grants-correct-amount', res.gained === 5);
check('collect-resource-name', res.resource === 'honey');
check('collect-adds-to-existing-inv-key', res.inv.honey === 8);
check('collect-preserves-other-inv-keys', res.inv.wood === 2);
check('collect-input-inv-untouched', deep(inv0, { wood: 2, honey: 3 }));
check('collect-advances-lastCollectedAt', res.struct.lastCollectedAt === 1000 + 45000 * 5);
check('collect-preserves-builtAt', res.struct.builtAt === 1000);
check('collect-input-struct-untouched', s.lastCollectedAt === 1000);

// collecting again immediately after yields nothing (no double-dipping the same window)
var res2 = I.collect(res.struct, res.inv, 1000 + 45000 * 5);
check('collect-twice-same-instant-yields-nothing', res2.gained === 0);

// overflow: waiting well past capacity, collecting, then waiting again starts a fresh window
var overflowed = I.collect(s, {}, 1000 + 45000 * 9999);
check('collect-after-overflow-grants-capacity-not-more', overflowed.gained === 20);
var afterOverflowCollect = I.accrued(overflowed.struct, overflowed.struct.lastCollectedAt + 45000);
check('post-overflow-collect-resets-the-clock-not-just-the-store', afterOverflowCollect === 1);

check('collect-unknown-kind-noop',
  I.collect({ kind: 'nope', lastCollectedAt: 0 }, { wood: 1 }, 1000).gained === 0);

// ---------------------------------------------------------------- describe
check('describe-mentions-name-and-resource', I.describe(s, 1000 + 45000 * 3).indexOf('apiary') !== -1
  && I.describe(s, 1000 + 45000 * 3).indexOf('honey') !== -1);
check('describe-unknown-safe', I.describe(null, 0) === 'unknown structure');

// ---------------------------------------------------------------- purity / hygiene
// Scan only executable code: strip block + line comments so doc prose cannot trip the check.
var source = require('fs').readFileSync('./src/idle.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-frozen-tables', Object.isFrozen(I.STRUCTURES) && Object.isFrozen(I.STRUCTURES.apiary));

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
