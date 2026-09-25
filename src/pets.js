/**
 * pets.js — companion catalog + tame/treat mechanics for STRATUM.
 *
 * WHY THIS FILE EXISTS
 *   Accessories dress the colonist; pets follow them. Two ways to earn one:
 *   TAME a wild species with bait (moss_hopper on map 0, cinder_hound on map 1,
 *   brine_lurker on map 2), or BUY a premium companion for a fixed 50,000 pending
 *   STRATUM (mossbulb, cinderpup, reefclaw — the number is the product, not tuned,
 *   not env'd). Treats (items + a little STRATUM) keep a pet active; an active pet
 *   widens stack limits and shows beside its owner. Buying and treats both burn
 *   through the standard split — companions are a sink that follows you around.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Time is ALWAYS passed in as a `now` argument. Never throws, never mutates.
 *   - Integer math throughout. Pet state is { out, lastTreatAt, owned } where owned
 *     maps id -> true; every helper tolerates malformed states by degrading safely.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Pets = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function isPosInt(n) { return isInt(n) && n > 0; }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  /** Fixed premium price. Deliberately NOT env-tunable — the number is the product. */
  var PRICE = 50000;
  /** Tame reach in tiles — matches the approach distance the client can walk. */
  var TAME_REACH = 6;
  /** How long one treat keeps a pet active. */
  var TREAT_MS = 2 * 3600 * 1000;
  /** Extra stack room per resource while a pet is active. */
  var CARRY_BONUS = 20;
  /** Bonus harvest units while a pet is active. A companion helps gather. */
  var HARVEST_BONUS = 1;
  /** Client render scale for the follower sprite. */
  var SCALE = 0.55;

  // Tame bait / treat costs use inventory item ids (ECO.RESOURCES + idle products).
  var PETS = deepFreeze([
    { id: 'moss_hopper', name: 'Moss Hopper', form: 'wisp', pal: '#7fae5a', job: 'scout',
      blurb: 'Tamed wild on the First Acre. Bobs beside you.',
      bait: 'honey', baitQty: 5, treatItem: 'honey', treatQty: 2, stratumCost: 25,
      speciesKind: 'MOSS_HOPPER', maps: [0], price: 0, art: null },
    { id: 'cinder_hound', name: 'Cinder Hound', form: 'hound', pal: '#c2552f', job: 'guard',
      blurb: 'Tamed wild in Ashen Hollow. Growls at brutes.',
      bait: 'crystal', baitQty: 3, treatItem: 'crystal', treatQty: 1, stratumCost: 25,
      speciesKind: 'CINDER_HOUND', maps: [1], price: 0, art: null },
    { id: 'brine_lurker', name: 'Brine Lurker', form: 'wisp', pal: '#4f8fae', job: 'forage',
      blurb: 'Tamed wild on the Sunken Shelf. Hums at low tide.',
      bait: 'herb', baitQty: 8, treatItem: 'herb', treatQty: 2, stratumCost: 25,
      speciesKind: 'BRINE_LURKER', maps: [2], price: 0, art: null },
    { id: 'mossbulb', name: 'Mossbulb', form: 'blob', pal: '#86c06a', job: 'scout',
      blurb: 'A blob that followed you home from the First Acre.',
      bait: null, baitQty: 0, treatItem: 'honey', treatQty: 2, stratumCost: 25,
      speciesKind: null, maps: [], price: PRICE, art: 'assets/pets/mossbulb.png' },
    { id: 'cinderpup', name: 'Cinderpup', form: 'pack', pal: '#4a4448', job: 'guard',
      blurb: 'Ember-cracked brute pup. Barks at wisps.',
      bait: null, baitQty: 0, treatItem: 'honey', treatQty: 2, stratumCost: 25,
      speciesKind: null, maps: [], price: PRICE, art: 'assets/pets/cinderpup.png' },
    { id: 'reefclaw', name: 'Reefclaw', form: 'tank', pal: '#5aa0a0', job: 'forage',
      blurb: 'Sunken Shelf crab. Clicks when STRATUM burns.',
      bait: null, baitQty: 0, treatItem: 'honey', treatQty: 2, stratumCost: 25,
      speciesKind: null, maps: [], price: PRICE, art: 'assets/pets/reefclaw.png' }
  ]);

  /** Pet record for an id, or null. Never throws. */
  function petOf(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < PETS.length; i++) {
      if (PETS[i].id === id) return PETS[i];
    }
    return null;
  }

  /** True for a real pet id. Never throws. */
  function isPet(id) {
    return petOf(id) !== null;
  }

  /** Tameable defs valid on `map` (fresh array, never the frozen rows). */
  function petsForMap(map) {
    var out = [];
    try {
      for (var i = 0; i < PETS.length; i++) {
        var p = PETS[i];
        if (p.speciesKind && p.maps && p.maps.indexOf(map) !== -1) out.push(p);
      }
    } catch (e) {}
    return out;
  }

  /** Fresh, petless state. Always a new object. */
  function emptyState() {
    return { out: null, lastTreatAt: 0, owned: {} };
  }

  function cleanState(st) {
    if (!st || typeof st !== 'object') return emptyState();
    var owned = {};
    try {
      var o = st.owned;
      if (o && typeof o === 'object') {
        for (var k in o) {
          if (Object.prototype.hasOwnProperty.call(o, k) && o[k] && petOf(k)) owned[k] = true;
        }
      }
    } catch (e) {}
    var out = (typeof st.out === 'string' && petOf(st.out) && owned[st.out]) ? st.out : null;
    var last = (typeof st.lastTreatAt === 'number' && isFinite(st.lastTreatAt) && st.lastTreatAt > 0)
      ? st.lastTreatAt : 0;
    return { out: out, lastTreatAt: last, owned: owned };
  }

  /** Ms of treat time left, 0 when none out or expired. Never throws. */
  function treatLeftMs(st, now) {
    try {
      if (typeof now !== 'number' || !isFinite(now)) return 0;
      var c = cleanState(st);
      if (!c.out) return 0;
      var left = TREAT_MS - (now - c.lastTreatAt);
      return left > 0 ? Math.floor(left) : 0;
    } catch (e) { return 0; }
  }

  /** True when a pet is out AND its treat is fresh. Never throws. */
  function isActive(st, now) {
    try {
      var c = cleanState(st);
      return !!c.out && treatLeftMs(c, now) > 0;
    } catch (e) { return false; }
  }

  /**
   * Treat (or tame-adopt) `petId` now: marks owned, sends it out, refreshes the
   * treat clock. Returns a FRESH state; never mutates the input. Unknown ids
   * leave ownership untouched (out unchanged). Never throws.
   */
  function applyTreat(st, petId, now) {
    try {
      var c = cleanState(st);
      var t = (typeof now === 'number' && isFinite(now) && now > 0) ? now : 0;
      if (typeof petId === 'string' && petOf(petId)) {
        var owned = {};
        for (var k in c.owned) {
          if (Object.prototype.hasOwnProperty.call(c.owned, k)) owned[k] = true;
        }
        owned[petId] = true;
        return { out: petId, lastTreatAt: t, owned: owned };
      }
      return c;
    } catch (e) { return emptyState(); }
  }

  /** Park the pet (out=null), keep ownership + clock. Fresh object. Never throws. */
  function park(st) {
    try {
      var c = cleanState(st);
      return { out: null, lastTreatAt: c.lastTreatAt, owned: c.owned };
    } catch (e) { return emptyState(); }
  }

  /** Extra stack room while a pet is active, else 0. Never throws. */
  function carryExtra(st, now) {
    try {
      return isActive(st, now) ? CARRY_BONUS : 0;
    } catch (e) { return 0; }
  }

  /**
   * Validate taming `petId`: must be a tameable def, the right wild species
   * must be near, and enough bait held. Returns { ok, error, cost:{item,qty} }.
   * Premium (priced) pets are never tameable. Never throws.
   */
  function validateTame(args) {
    try {
      var a = (args && typeof args === 'object') ? args : {};
      var def = petOf(a.petId);
      if (!def) return { ok: false, error: 'no such pet', cost: null };
      if (!def.speciesKind || (def.price | 0) > 0) {
        return { ok: false, error: 'cannot tame', cost: null };
      }
      if (a.nearSpeciesKind !== def.speciesKind) {
        return { ok: false, error: 'not near species', cost: null };
      }
      var held = (typeof a.baitHeld === 'number' && isFinite(a.baitHeld)) ? Math.floor(a.baitHeld) : 0;
      if (held < def.baitQty) return { ok: false, error: 'need bait', cost: { item: def.bait, qty: def.baitQty } };
      return { ok: true, error: null, cost: { item: def.bait, qty: def.baitQty } };
    } catch (e) { return { ok: false, error: 'bad request', cost: null }; }
  }

  /**
   * Validate treating `petId`: must be owned AND out, treat items held, and
   * enough pending STRATUM. Returns { ok, error, pet, itemCost, stratumCost }.
   * Never throws.
   */
  function validateTreat(args) {
    try {
      var a = (args && typeof args === 'object') ? args : {};
      var def = petOf(a.petId);
      if (!def) return { ok: false, error: 'no such pet', pet: null, itemCost: 0, stratumCost: 0 };
      if (!a.owned) return { ok: false, error: 'not owned', pet: def, itemCost: 0, stratumCost: 0 };
      if (a.out !== a.petId) return { ok: false, error: 'not out', pet: def, itemCost: 0, stratumCost: 0 };
      var held = (typeof a.itemHeld === 'number' && isFinite(a.itemHeld)) ? Math.floor(a.itemHeld) : 0;
      if (held < def.treatQty) {
        return { ok: false, error: 'need treat', pet: def, itemCost: def.treatQty, stratumCost: def.stratumCost };
      }
      var pend = (typeof a.pendingStratum === 'number' && isFinite(a.pendingStratum))
        ? Math.floor(a.pendingStratum) : 0;
      if (pend < def.stratumCost) {
        return { ok: false, error: 'need stratum', pet: def, itemCost: def.treatQty, stratumCost: def.stratumCost };
      }
      return { ok: true, error: null, pet: def, itemCost: def.treatQty, stratumCost: def.stratumCost };
    } catch (e) { return { ok: false, error: 'bad request', pet: null, itemCost: 0, stratumCost: 0 }; }
  }

  /** Extra harvest units for an active pet (nodeKind accepted, ignored — a
   *  companion helps gather whatever is swung at). 0 when inactive. Never throws. */
  function harvestBonus(st, nodeKind, now) {
    try {
      return isActive(st, now) ? HARVEST_BONUS : 0;
    } catch (e) { return 0; }
  }

  /** True when an active pet should ping its owner about a ripened node
   *  (same gate as every other active-pet perk). Never throws. */
  function ripePing(st, now) {
    try {
      return isActive(st, now);
    } catch (e) { return false; }
  }

  function hasId(ownedIds, id) {
    if (!ownedIds) return false;
    if (typeof ownedIds.has === 'function') { try { return !!ownedIds.has(id); } catch (e) { return false; } }
    if (Array.isArray(ownedIds)) return ownedIds.indexOf(id) !== -1;
    if (typeof ownedIds === 'object') return !!ownedIds[id];
    return false;
  }

  /**
   * Validate buying premium `petId` with `pending` and `ownedIds`. Only priced
   * defs are for sale. Returns { ok, price, error }. Never throws.
   */
  function validatePetBuy(petId, pending, ownedIds) {
    try {
      var def = petOf(petId);
      if (!def || !(def.price > 0)) return { ok: false, price: 0, error: 'not for sale' };
      if (hasId(ownedIds, petId)) return { ok: false, price: 0, error: 'already owned' };
      if (typeof pending !== 'number' || !isFinite(pending) || Math.floor(pending) < def.price) {
        return { ok: false, price: def.price, error: 'need 50000 STRATUM pending' };
      }
      return { ok: true, price: def.price, error: null };
    } catch (e) { return { ok: false, price: 0, error: 'bad request' }; }
  }

  /**
   * Validate equipping `petId` (or null to dismiss) against `ownedIds`.
   * Returns the pet id to store, or null. Never throws.
   */
  function validatePetEquip(petId, ownedIds) {
    try {
      if (petId === null || petId === undefined || petId === '') return null;
      if (typeof petId !== 'string' || !petOf(petId)) return null;
      if (!hasId(ownedIds, petId)) return null;
      return petId;
    } catch (e) { return null; }
  }

  return {
    PRICE: PRICE,
    TAME_REACH: TAME_REACH,
    TREAT_MS: TREAT_MS,
    CARRY_BONUS: CARRY_BONUS,
    HARVEST_BONUS: HARVEST_BONUS,
    SCALE: SCALE,
    PETS: PETS,
    petOf: petOf,
    isPet: isPet,
    petsForMap: petsForMap,
    emptyState: emptyState,
    treatLeftMs: treatLeftMs,
    isActive: isActive,
    applyTreat: applyTreat,
    park: park,
    carryExtra: carryExtra,
    harvestBonus: harvestBonus,
    ripePing: ripePing,
    validateTame: validateTame,
    validateTreat: validateTreat,
    validatePetBuy: validatePetBuy,
    validatePetEquip: validatePetEquip
  };
});
