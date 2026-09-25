/* test-customization.js — assertions for src/customization.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var C = require('./src/customization.js');
var A = require('./src/achievements.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }
function snap(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------- palette table shape
check('palette-count-in-range', C.ALL_PALETTES.length >= 24 && C.ALL_PALETTES.length <= 32);
var pIds = C.ALL_PALETTES.map(function (p) { return p.id; });
check('palette-ids-unique', new Set(pIds).size === pIds.length);
check('palette-shape-valid', C.ALL_PALETTES.every(function (p) {
  return typeof p.id === 'string' && typeof p.name === 'string' && p.name.length > 0 &&
    Number.isInteger(p.bodyHue) && p.bodyHue >= 0 && p.bodyHue < 360 &&
    Number.isInteger(p.trimHue) && p.trimHue >= 0 && p.trimHue < 360;
}));

// ---------------------------------------------------------------- accessory table shape
check('accessory-count-in-range', C.ALL_ACCESSORIES.length >= 6 && C.ALL_ACCESSORIES.length <= 24);
var aIds = C.ALL_ACCESSORIES.map(function (a) { return a.id; });
check('accessory-ids-unique', new Set(aIds).size === aIds.length);
check('accessory-shape-valid', C.ALL_ACCESSORIES.every(function (a) {
  return typeof a.id === 'string' && typeof a.name === 'string' && a.name.length > 0 &&
    C.SLOTS.indexOf(a.slot) !== -1 &&
    (a.unlockedBy === undefined || typeof a.unlockedBy === 'string') &&
    (a.priceStratum === undefined || (Number.isInteger(a.priceStratum) && a.priceStratum > 0));
}));
check('vanity-row-priced', C.ALL_ACCESSORIES.filter(function (a) { return C.isVanity(a.id); }).length === 6);
check('slots-in-range', C.SLOTS.length >= 2 && C.SLOTS.length <= 6);
// every unlockedBy id must be a real achievement id from src/achievements.js, verbatim
check('unlockedBy-ids-are-real-achievements', C.ALL_ACCESSORIES.every(function (a) {
  return typeof a.unlockedBy !== 'string' || !!A.achievementById(a.unlockedBy);
}));
check('at-least-one-free-accessory', C.ALL_ACCESSORIES.some(function (a) { return typeof a.unlockedBy !== 'string'; }));
check('at-least-one-gated-accessory', C.ALL_ACCESSORIES.some(function (a) { return typeof a.unlockedBy === 'string'; }));

// ---------------------------------------------------------------- lookups
check('paletteOf-known', C.paletteOf('moss') && C.paletteOf('moss').id === 'moss');
check('paletteOf-unknown-null', C.paletteOf('nope') === null);
check('paletteOf-non-string-null', C.paletteOf(42) === null && C.paletteOf(null) === null && C.paletteOf(undefined) === null);
check('accessoryOf-known', C.accessoryOf('plain-cap') && C.accessoryOf('plain-cap').id === 'plain-cap');
check('accessoryOf-unknown-null', C.accessoryOf('nope') === null);

// ---------------------------------------------------------------- cosmeticFor
var gatedAcc = C.ALL_ACCESSORIES.filter(function (a) { return typeof a.unlockedBy === 'string'; })[0];
check('cosmeticFor-known-achievement', C.cosmeticFor(gatedAcc.unlockedBy) === gatedAcc.id);
check('cosmeticFor-achievement-with-no-cosmetic-null',
  C.cosmeticFor(A.ACHIEVEMENTS.map(function (a) { return a.id; })
    .find(function (id) { return !C.ALL_ACCESSORIES.some(function (a) { return a.unlockedBy === id; }); })) === null);
check('cosmeticFor-unknown-id-null', C.cosmeticFor('nope') === null);
check('cosmeticFor-non-string-null', C.cosmeticFor(null) === null && C.cosmeticFor(42) === null);

// ---------------------------------------------------------------- isUnlocked
var freeAcc = C.ALL_ACCESSORIES.filter(function (a) { return typeof a.unlockedBy !== 'string'; })[0];
check('isUnlocked-free-accessory-always-true', C.isUnlocked(freeAcc.id, []) === true);
check('isUnlocked-gated-true-when-known', C.isUnlocked(gatedAcc.id, [gatedAcc.unlockedBy]) === true);
check('isUnlocked-gated-false-when-missing', C.isUnlocked(gatedAcc.id, []) === false);
check('isUnlocked-gated-false-with-unrelated-ids', C.isUnlocked(gatedAcc.id, ['first-blood', 'rising']) === false);
check('isUnlocked-works-with-Set', C.isUnlocked(gatedAcc.id, new Set([gatedAcc.unlockedBy])) === true);
check('isUnlocked-unknown-accessory-false', C.isUnlocked('nope', [gatedAcc.unlockedBy]) === false);
check('isUnlocked-malformed-known-false', C.isUnlocked(gatedAcc.id, null) === false && C.isUnlocked(gatedAcc.id, undefined) === false);

// ---------------------------------------------------------------- validateLook
check('validateLook-valid-free-palette-kept',
  C.validateLook({ paletteId: 'clay', hat: null, cloak: null, scarf: null }, []).paletteId === 'clay');
check('validateLook-unknown-palette-falls-back-to-default',
  C.validateLook({ paletteId: 'not-a-palette' }, []).paletteId === C.DEFAULT_PALETTE_ID);
check('validateLook-strips-unowned-accessory',
  C.validateLook({ paletteId: 'moss', hat: gatedAcc.id }, []).hat === null);
check('validateLook-keeps-owned-accessory',
  C.validateLook({ paletteId: 'moss', hat: gatedAcc.slot === 'hat' ? gatedAcc.id : null },
    [gatedAcc.unlockedBy])[gatedAcc.slot] === gatedAcc.id);
check('validateLook-keeps-free-accessory-without-unlocks', (function () {
  var req = { paletteId: 'moss' }; req[freeAcc.slot] = freeAcc.id;
  return C.validateLook(req, [])[freeAcc.slot] === freeAcc.id;
})());
check('validateLook-rejects-accessory-in-wrong-slot', (function () {
  var wrongSlot = C.SLOTS.filter(function (s) { return s !== freeAcc.slot; })[0];
  var req = {}; req[wrongSlot] = freeAcc.id;
  return C.validateLook(req, [])[wrongSlot] === null;
})());
check('validateLook-never-mutates-input', (function () {
  var req = { paletteId: 'moss', hat: 'bogus' };
  var before = snap(req);
  C.validateLook(req, []);
  return snap(req) === before;
})());
check('validateLook-always-fresh-object', (function () {
  var req = { paletteId: 'moss' };
  var r1 = C.validateLook(req, []); r1.paletteId = 'clay';
  var r2 = C.validateLook(req, []);
  return r2.paletteId === 'moss';
})());

// garbage input degrades to a safe default, never throws
[null, undefined, 42, 'x', true, [], [1, 2], function () {}, {}].forEach(function (bad, i) {
  var ok = !throws(function () { C.validateLook(bad, []); });
  var r = ok ? C.validateLook(bad, []) : null;
  check('validateLook-garbage-' + i + '-clean', ok && r && r.paletteId === C.DEFAULT_PALETTE_ID &&
    r.hat === null && r.cloak === null && r.scarf === null);
});
check('validateLook-garbage-unlockedAchievementIds-clean',
  !throws(function () { C.validateLook({ paletteId: 'moss' }, 'not-an-array'); }) &&
  C.validateLook({ paletteId: 'moss' }, 'not-an-array').paletteId === 'moss');
check('validateLook-null-look-with-garbage-unlocked',
  !throws(function () { C.validateLook(null, { a: 1 }); }) && C.validateLook(null, { a: 1 }).paletteId === C.DEFAULT_PALETTE_ID);

// ---------------------------------------------------------------- defaultLook
check('defaultLook-shape', (function () {
  var d = C.defaultLook();
  return d.paletteId === C.DEFAULT_PALETTE_ID && d.hat === null && d.cloak === null && d.scarf === null &&
    d.visor === null && d.pack === null && d.patch === null;
})());
check('defaultLook-fresh-object', (function () {
  var d1 = C.defaultLook(); d1.paletteId = 'clay';
  var d2 = C.defaultLook();
  return d2.paletteId === C.DEFAULT_PALETTE_ID;
})());

// ---------------------------------------------------------------- suit-tech slots
check('suit-slots-present', ['visor', 'pack', 'patch'].every(function (s) { return C.SLOTS.indexOf(s) !== -1; }));
check('suit-free-equips', (function () {
  var r = C.validateLook({ paletteId: 'moss', visor: 'dust-visor', pack: 'survey-pack', patch: 'landing-patch' }, [], []);
  return r.visor === 'dust-visor' && r.pack === 'survey-pack' && r.patch === 'landing-patch';
})());
check('suit-gated-needs-achievement', (function () {
  var locked = C.validateLook({ paletteId: 'moss', visor: 'surveyor-visor' }, [], []);
  var open = C.validateLook({ paletteId: 'moss', visor: 'surveyor-visor' }, ['wayfarer'], []);
  return locked.visor === null && open.visor === 'surveyor-visor';
})());
check('suit-vanity-priced', C.vanityPrice('eclipse-visor') === 150 && C.vanityPrice('ion-thruster') === 300 && C.vanityPrice('goldleaf-insignia') === 400);
check('suit-vanity-gated-by-ownership', (function () {
  var stripped = C.validateLook({ paletteId: 'moss', pack: 'ion-thruster' }, [], []);
  var kept = C.validateLook({ paletteId: 'moss', pack: 'ion-thruster' }, [], ['ion-thruster']);
  return stripped.pack === null && kept.pack === 'ion-thruster';
})());
check('suit-wrong-slot-rejected',
  C.validateLook({ paletteId: 'moss', hat: 'dust-visor' }, [], []).hat === null);

// ---------------------------------------------------------------- purity / hygiene
// Scan only executable code: strip block + line comments so doc prose cannot trip the check.
var source = require('fs').readFileSync('./src/customization.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-frozen-tables', Object.isFrozen(C.ALL_PALETTES) && Object.isFrozen(C.ALL_PALETTES[0]) &&
  Object.isFrozen(C.ALL_ACCESSORIES) && Object.isFrozen(C.ALL_ACCESSORIES[0]) && Object.isFrozen(C.SLOTS));

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
