/* test-drops.js — assertions for src/drops.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var D = require('./src/drops.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function snap(v) { return JSON.stringify(v); }
function deep(a, b) { return snap(a) === snap(b); }

// ---------------------------------------------------------------- 1. death split
var richInv = { wood: 3, ore: 7, herb: 1, crystal: 0, steel_blade: 2, iron_mail: 1 };
var richBefore = snap(richInv);
var split = D.dropsForDeath(richInv);

check('half-floor-3-wood-drops-1-keeps-2',
  split.dropped.wood === 1 && split.kept.wood === 2);
check('half-floor-7-ore-drops-3-keeps-4',
  split.dropped.ore === 3 && split.kept.ore === 4);
check('half-floor-1-herb-drops-nothing',
  split.dropped.herb === undefined && split.kept.herb === 1);
check('zero-crystal-not-dropped',
  split.dropped.crystal === undefined);
check('gear-never-drops',
  split.dropped.steel_blade === undefined && split.dropped.iron_mail === undefined);
check('gear-is-kept',
  split.kept.steel_blade === 2 && split.kept.iron_mail === 1);
check('dropped-contains-only-resources',
  Object.keys(split.dropped).every(function (k) { return D.RESOURCES.indexOf(k) !== -1; }));
check('input-untouched-by-dropsForDeath', snap(richInv) === richBefore);
check('dropsForDeath-returns-fresh-objects', split.dropped !== richInv && split.kept !== richInv);

// poor / empty inventories
var poor = { wood: 1, ore: 1, herb: 0 };
var poorSplit = D.dropsForDeath(poor);
check('poor-inv-drops-nothing', deep(poorSplit.dropped, {}));
check('poor-inv-keeps-everything',
  poorSplit.kept.wood === 1 && poorSplit.kept.ore === 1 && poorSplit.kept.herb === 0);
check('empty-inv-drops-nothing', deep(D.dropsForDeath({}).dropped, {}));
check('empty-inv-kept-is-empty', deep(D.dropsForDeath({}).kept, {}));
check('null-inv-drops-nothing', deep(D.dropsForDeath(null).dropped, {}));
check('junk-entries-ignored',
  deep(D.dropsForDeath({ wood: -5, ore: NaN, herb: '3', crystal: 2.5, iron_axe: 1 }).dropped, {}));

// gear-only death drops nothing at all
check('gear-only-inv-drops-nothing',
  deep(D.dropsForDeath({ steel_blade: 5, iron_mail: 2 }).dropped, {}));

// ---------------------------------------------------------------- 2. makeDrop validation
var okDrop = D.makeDrop('d1', 'world', 10, 20, { wood: 2, ore: 1 }, 1000);
check('makeDrop-happy-path',
  okDrop && okDrop.id === 'd1' && okDrop.map === 'world' && okDrop.x === 10 &&
  okDrop.y === 20 && deep(okDrop.res, { wood: 2, ore: 1 }) && okDrop.at === 1000);
check('makeDrop-default-ttl-10min', okDrop.ttlMs === 600000 && D.DEFAULT_TTL_MS === 600000);
check('makeDrop-explicit-ttl',
  D.makeDrop('d1', 'world', 0, 0, { wood: 1 }, 0, 5000).ttlMs === 5000);

check('makeDrop-rejects-empty-id', D.makeDrop('', 'world', 1, 1, { wood: 1 }, 0) === null);
check('makeDrop-rejects-nonstring-id', D.makeDrop(7, 'world', 1, 1, { wood: 1 }, 0) === null);
check('makeDrop-rejects-null-id', D.makeDrop(null, 'world', 1, 1, { wood: 1 }, 0) === null);
check('makeDrop-rejects-bad-map', D.makeDrop('d', '', 1, 1, { wood: 1 }, 0) === null);
check('makeDrop-rejects-missing-map', D.makeDrop('d', null, 1, 1, { wood: 1 }, 0) === null);

check('makeDrop-rejects-x-negative', D.makeDrop('d', 'm', -1, 0, { wood: 1 }, 0) === null);
check('makeDrop-rejects-x-at-W', D.makeDrop('d', 'm', 1024, 0, { wood: 1 }, 0) === null);
check('makeDrop-rejects-y-at-H', D.makeDrop('d', 'm', 0, 1024, { wood: 1 }, 0) === null);
check('makeDrop-rejects-float-coords', D.makeDrop('d', 'm', 1.5, 2, { wood: 1 }, 0) === null);
check('makeDrop-rejects-nan-coords', D.makeDrop('d', 'm', NaN, 2, { wood: 1 }, 0) === null);
check('makeDrop-accepts-corner-coords',
  D.makeDrop('d', 'm', 0, 0, { wood: 1 }, 0) !== null &&
  D.makeDrop('d', 'm', 1023, 1023, { wood: 1 }, 0) !== null);
check('makeDrop-rejects-bad-now',
  D.makeDrop('d', 'm', 1, 1, { wood: 1 }, null) === null &&
  D.makeDrop('d', 'm', 1, 1, { wood: 1 }, 1.5) === null);
check('makeDrop-rejects-bad-ttl',
  D.makeDrop('d', 'm', 1, 1, { wood: 1 }, 0, 0) === null &&
  D.makeDrop('d', 'm', 1, 1, { wood: 1 }, 0, -5) === null &&
  D.makeDrop('d', 'm', 1, 1, { wood: 1 }, 0, '10') === null);

check('makeDrop-rejects-empty-res', D.makeDrop('d', 'm', 1, 1, {}, 0) === null);
check('makeDrop-rejects-null-res', D.makeDrop('d', 'm', 1, 1, null, 0) === null);
check('makeDrop-rejects-all-zero-res', D.makeDrop('d', 'm', 1, 1, { wood: 0, ore: 0 }, 0) === null);
check('makeDrop-rejects-junk-res', D.makeDrop('d', 'm', 1, 1, { wood: -2, ore: NaN }, 0) === null);
check('makeDrop-drops-only-positive-entries',
  deep(D.makeDrop('d', 'm', 1, 1, { wood: 3, ore: 0, herb: -1 }, 0).res, { wood: 3 }));
check('makeDrop-keeps-non-resource-keys-out-of-res',
  deep(D.makeDrop('d', 'm', 1, 1, { wood: 3, herb: 1 }, 0).res, { wood: 3, herb: 1 }));

// ---------------------------------------------------------------- 3. pickup grants
var ground = D.makeDrop('d1', 'm', 5, 5, { wood: 4, ore: 2 }, 1000);
var bag = { wood: 10, ore: 0, herb: 0, crystal: 0 };
var bagBefore = snap(bag);
var got = D.pickup(ground, bag, 1000);

check('pickup-ok', got.ok === true);
check('pickup-grants-resources',
  got.inv.wood === 14 && got.inv.ore === 2);
check('pickup-reports-taken', deep(got.taken, { wood: 4, ore: 2 }));
check('pickup-no-leftover-when-room', got.left === null);
check('pickup-returns-NEW-inv', got.inv !== bag);
check('pickup-input-unmutated', snap(bag) === bagBefore);
check('pickup-does-not-mutate-drop', deep(ground.res, { wood: 4, ore: 2 }));

var fresh = D.pickup(ground, {}, 1000);
check('pickup-into-empty-inv', fresh.ok && fresh.inv.wood === 4 && fresh.inv.ore === 2);
check('pickup-into-null-inv', D.pickup(ground, null, 1000).ok === true);
check('pickup-preserves-unknown-keys',
  D.pickup(ground, { steel_blade: 2 }, 1000).inv.steel_blade === 2);

// ---------------------------------------------------------------- 4. clamping + leftover
var bigDrop = D.makeDrop('d2', 'm', 1, 1, { wood: 500, ore: 500, herb: 300, crystal: 300 }, 0);
var empty = {};
var clamped = D.pickup(bigDrop, empty, 0);
check('pickup-ok-despite-clamp', clamped.ok === true);
check('pickup-clamps-wood-400', clamped.inv.wood === 400);
check('pickup-clamps-ore-400', clamped.inv.ore === 400);
check('pickup-clamps-herb-200', clamped.inv.herb === 200);
check('pickup-clamps-crystal-100', clamped.inv.crystal === 100);
check('pickup-reports-leftover',
  deep(clamped.left, { wood: 100, ore: 100, herb: 100, crystal: 200 }));
check('pickup-taken-counts-only-what-moved',
  deep(clamped.taken, { wood: 400, ore: 400, herb: 200, crystal: 100 }));

// partially full inventory: room is the bound, not the limit
var partly = { wood: 395, ore: 0, herb: 0, crystal: 0 };
var partial = D.pickup(D.makeDrop('d3', 'm', 1, 1, { wood: 50 }, 0), partly, 0);
check('pickup-partial-room-takes-5', partial.ok && partial.inv.wood === 400);
check('pickup-partial-reports-45-left', deep(partial.left, { wood: 45 }));
check('pickup-partial-input-unmutated', partly.wood === 395);

// full stack: nothing taken -> empty
var full = { wood: 400, ore: 0, herb: 0, crystal: 0 };
check('pickup-full-stack-refused-empty',
  D.pickup(D.makeDrop('d4', 'm', 1, 1, { wood: 5 }, 0), full, 0).reason === 'empty');
check('pickup-full-stack-inv-untouched',
  snap(D.pickup(D.makeDrop('d4', 'm', 1, 1, { wood: 5 }, 0), full, 0).inv) === snap(full));

// custom limits respected
var custom = D.pickup(D.makeDrop('d5', 'm', 1, 1, { crystal: 50 }, 0), {}, 0, { crystal: 5 });
check('pickup-custom-limits', custom.ok && custom.inv.crystal === 5 && custom.left.crystal === 45);

// ---------------------------------------------------------------- 5. expiry
var t = 1000;
check('expired-false-at-at', D.expired({ at: t, ttlMs: 100 }, t) === false);
check('expired-false-at-exact-boundary', D.expired({ at: t, ttlMs: 100 }, t + 100) === false);
check('expired-true-just-past-boundary', D.expired({ at: t, ttlMs: 100 }, t + 101) === true);
check('expired-true-far-past', D.expired({ at: t, ttlMs: 100 }, t + 100000) === true);
check('expired-false-when-clock-skewed-back', D.expired({ at: t, ttlMs: 100 }, t - 50) === false);
check('expired-malformed-true', D.expired(null, t) === true && D.expired({ at: t }, t) === true);

var oldDrop = D.makeDrop('d6', 'm', 1, 1, { wood: 3 }, 1000);
var oldInv = { wood: 1, ore: 0, herb: 0, crystal: 0 };
var oldSnap = snap(oldInv);
var dead = D.pickup(oldDrop, oldInv, 1000 + 600001);
check('expired-pickup-refused', dead.ok === false);
check('expired-pickup-reason', dead.reason === 'expired');
check('expired-pickup-no-mutation', snap(dead.inv) === oldSnap && dead.inv === oldInv);
check('expired-pickup-just-inside-ttl',
  D.pickup(oldDrop, oldInv, 1000 + 600000).ok === true);

// ---------------------------------------------------------------- 6. invalid / empty pickup
check('pickup-empty-drop-reason',
  D.pickup(D.makeDrop('d7', 'm', 1, 1, { wood: 1 }, 0), {}, 0, {}).ok === true);
check('pickup-zero-total-reason',
  D.pickup({ id: 'x', map: 'm', x: 1, y: 1, res: {}, at: 0, ttlMs: 100 }, {}, 0).reason === 'empty');
check('pickup-junk-drop-invalid', D.pickup(null, {}, 0).reason === 'invalid');
check('pickup-junk-drop-reason-shape',
  D.pickup({ id: '', map: 'm', x: 1, y: 1, res: { wood: 1 }, at: 0, ttlMs: 100 }, {}, 0).reason === 'invalid');
check('pickup-bad-now-invalid', D.pickup(ground, {}, NaN).reason === 'invalid');
check('pickup-invalid-inv-untouched',
  snap(D.pickup(null, oldInv, 0).inv) === oldSnap);
check('pickup-fail-taken-null', D.pickup(null, {}, 0).taken === null);

// ---------------------------------------------------------------- 7. describe
check('describe-two-one',
  D.describe({ id: 'x', res: { wood: 2, ore: 1 } }) === '2 wood + 1 ore');
check('describe-single', D.describe({ res: { crystal: 4 } }) === '4 crystal');
check('describe-empty-cache', D.describe({ res: {} }) === 'an empty cache');
check('describe-all-four-order',
  D.describe({ res: { wood: 1, ore: 2, herb: 3, crystal: 4 } }) === '1 wood + 2 ore + 3 herb + 4 crystal');
check('describe-junk-is-empty-cache',
  D.describe({ res: { wood: 0 } }) === 'an empty cache' && D.describe(null) === 'an empty cache');
check('describe-real-drop-from-death',
  D.describe({ res: D.dropsForDeath({ ore: 5, herb: 3 }).dropped }) === '2 ore + 1 herb');

// ---------------------------------------------------------------- 8. determinism + purity
var inv = { wood: 9, ore: 4, herb: 3, crystal: 2, flint_dagger: 1 };
var a1 = D.dropsForDeath(inv), a2 = D.dropsForDeath(inv);
check('determinism-dropsForDeath',
  deep(a1.dropped, a2.dropped) && deep(a1.kept, a2.kept));

var dA = D.makeDrop('same', 'map', 3, 4, { wood: 5, ore: 2 }, 777);
var dB = D.makeDrop('same', 'map', 3, 4, { wood: 5, ore: 2 }, 777);
check('determinism-makeDrop', deep(dA, dB));

var p1 = D.pickup(dA, { wood: 1 }, 800), p2 = D.pickup(dB, { wood: 1 }, 800);
check('determinism-pickup',
  deep({ ok: p1.ok, inv: p1.inv, taken: p1.taken, left: p1.left },
       { ok: p2.ok, inv: p2.inv, taken: p2.taken, left: p2.left }));

check('determinism-describe',
  D.describe(dA) === D.describe(dB) && D.describe(dA) === '5 wood + 2 ore');
check('determinism-expired',
  D.expired(dA, 800) === D.expired(dB, 800));

var invSnap = snap(inv);
var reuse = D.pickup(D.makeDrop('r', 'm', 1, 1, { wood: 2 }, 0), inv, 0);
check('sequence-does-not-drift-input', snap(inv) === invSnap);
check('sequence-keeps-gear', reuse.inv.flint_dagger === 1);
// Scan only executable code: strip block + line comments so doc prose cannot trip the check.
var source = require('fs').readFileSync('./src/drops.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-frozen-tables',
  Object.isFrozen(D.STACK_LIMITS) && Object.isFrozen(D.RESOURCES));
check('frozen-tables-reject-writes',
  (function () { try { D.RESOURCES.push('gold'); } catch (e) { return true; } return D.RESOURCES.indexOf('gold') === -1; })());

// ---------------------------------------------------------------- summary
console.log('');
if (failures === 0) console.log('ALL PASS');
else console.log(failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
