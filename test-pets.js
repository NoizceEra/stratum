'use strict';
/* test-pets.js — pure unit tests for src/pets.js (catalog + tame/treat + buy).
 * No server, no sockets. */
const P = require('./src/pets.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// ---- catalog ----
check('six-pets', P.PETS.length === 6);
check('tameable-three', P.petsForMap(0).map(p => p.id).join(',') === 'moss_hopper');
check('petsForMap-1', P.petsForMap(1).map(p => p.id).join(',') === 'cinder_hound');
check('petsForMap-2', P.petsForMap(2).map(p => p.id).join(',') === 'brine_lurker');
check('petsForMap-unknown', P.petsForMap(99).length === 0);
check('premium-price-50000', P.PRICE === 50000 &&
  ['mossbulb', 'cinderpup', 'reefclaw'].every(id => P.petOf(id).price === 50000));
check('premium-art', ['mossbulb', 'cinderpup', 'reefclaw'].every(id => P.petOf(id).art === 'assets/pets/' + id + '.png'));
check('frozen', Object.isFrozen(P.PETS) && Object.isFrozen(P.PETS[0]));
check('petOf-unknown', P.petOf('dragon') === null && P.petOf(null) === null);
check('isPet', P.isPet('moss_hopper') === true && P.isPet('xx') === false);
check('consts', P.TAME_REACH === 6 && P.TREAT_MS === 7200000 && P.CARRY_BONUS === 20);

// ---- state ----
check('emptyState', JSON.stringify(P.emptyState()) === JSON.stringify({ out: null, lastTreatAt: 0, owned: {} }));
check('isActive-false-fresh', P.isActive(P.emptyState(), Date.now()) === false);
check('isActive-true-treated', (function () {
  const st = P.applyTreat(P.emptyState(), 'moss_hopper', 1000000);
  return P.isActive(st, 1000000 + 1000) === true;
})());
check('isActive-expired', (function () {
  const st = P.applyTreat(P.emptyState(), 'moss_hopper', 1000);
  return P.isActive(st, 1000 + P.TREAT_MS + 1) === false;
})());
check('treatLeftMs', (function () {
  const st = P.applyTreat(P.emptyState(), 'moss_hopper', 5000);
  return P.treatLeftMs(st, 6000) === P.TREAT_MS - 1000 && P.treatLeftMs(P.emptyState(), 6000) === 0;
})());
check('park', (function () {
  const st = P.applyTreat(P.emptyState(), 'moss_hopper', 5000);
  const p = P.park(st);
  return p.out === null && p.owned.moss_hopper === true && P.isActive(p, 6000) === false;
})());
check('applyTreat-unknown-keeps', (function () {
  const st = P.applyTreat(P.emptyState(), 'dragon', 5000);
  return st.out === null && Object.keys(st.owned).length === 0;
})());
check('carryExtra', P.carryExtra(P.applyTreat(P.emptyState(), 'moss_hopper', 5000), 6000) === 20 &&
  P.carryExtra(P.emptyState(), 6000) === 0);
check('harvestBonus-active', P.harvestBonus(P.applyTreat(P.emptyState(), 'moss_hopper', 5000), 1, 6000) === 1);
check('harvestBonus-inactive', P.harvestBonus(P.emptyState(), 1, 6000) === 0 &&
  P.harvestBonus(null, null, null) === 0);
check('ripePing', P.ripePing(P.applyTreat(P.emptyState(), 'moss_hopper', 5000), 6000) === true &&
  P.ripePing(P.emptyState(), 6000) === false && P.ripePing(null, null) === false);
check('scale', P.SCALE === 0.55);
check('state-never-throws', (function () {
  try {
    P.isActive(null, null); P.treatLeftMs('x', 'y'); P.applyTreat(null, null, null);
    P.park(null); P.carryExtra(null, null); P.petsForMap('x');
    return true;
  } catch (e) { return false; }
})());

// ---- tame ----
check('tame-ok', (function () {
  const v = P.validateTame({ petId: 'moss_hopper', map: 0, baitHeld: 5, nearSpeciesKind: 'MOSS_HOPPER' });
  return v.ok === true && v.cost.item === 'honey' && v.cost.qty === 5;
})());
check('tame-unknown', P.validateTame({ petId: 'dragon' }).error === 'no such pet');
check('tame-premium-refused', P.validateTame({ petId: 'mossbulb', map: 0, baitHeld: 99, nearSpeciesKind: 'MOSS_HOPPER' }).error === 'cannot tame');
check('tame-not-near', P.validateTame({ petId: 'moss_hopper', map: 0, baitHeld: 5, nearSpeciesKind: null }).error === 'not near species');
check('tame-no-bait', P.validateTame({ petId: 'moss_hopper', map: 0, baitHeld: 0, nearSpeciesKind: 'MOSS_HOPPER' }).error === 'need bait');
check('tame-never-throws', (function () {
  try { P.validateTame(null); P.validateTame('x'); return true; } catch (e) { return false; }
})());

// ---- treat ----
check('treat-ok', (function () {
  const v = P.validateTreat({ petId: 'moss_hopper', owned: true, out: 'moss_hopper', itemHeld: 9, pendingStratum: 100 });
  return v.ok === true && v.itemCost === 2 && v.stratumCost === 25;
})());
check('treat-not-owned', P.validateTreat({ petId: 'moss_hopper', owned: false, out: null, itemHeld: 9, pendingStratum: 100 }).error === 'not owned');
check('treat-not-out', P.validateTreat({ petId: 'moss_hopper', owned: true, out: null, itemHeld: 9, pendingStratum: 100 }).error === 'not out');
check('treat-no-item', P.validateTreat({ petId: 'moss_hopper', owned: true, out: 'moss_hopper', itemHeld: 0, pendingStratum: 100 }).error === 'need treat');
check('treat-no-stratum', P.validateTreat({ petId: 'moss_hopper', owned: true, out: 'moss_hopper', itemHeld: 9, pendingStratum: 0 }).error === 'need stratum');
check('treat-unknown', P.validateTreat({ petId: 'dragon' }).error === 'no such pet');

// ---- buy (premium, fixed 50k) ----
check('buy-ok', JSON.stringify(P.validatePetBuy('mossbulb', 50000, [])) ===
  JSON.stringify({ ok: true, price: 50000, error: null }));
check('buy-tameable-not-for-sale', P.validatePetBuy('moss_hopper', 99999, []).error === 'not for sale');
check('buy-unknown', P.validatePetBuy('dragon', 99999, []).error === 'not for sale');
check('buy-owned', P.validatePetBuy('reefclaw', 99999, { reefclaw: true }).error === 'already owned');
check('buy-poor', P.validatePetBuy('cinderpup', 49999, []).error === 'need 50000 STRATUM pending');
check('equip-ok', P.validatePetEquip('cinderpup', ['cinderpup']) === 'cinderpup');
check('equip-unowned', P.validatePetEquip('cinderpup', []) === null);
check('equip-dismiss', P.validatePetEquip(null, []) === null);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
