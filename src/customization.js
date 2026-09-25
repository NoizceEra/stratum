/**
 * customization.js — appearance catalog for STRATUM: palettes + accessories.
 *
 * CONTRACT (mirrors src/achievements.js exactly)
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Customization = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - Palettes are the free baseline layer: every player may pick any of them from the
 *     start. Accessories are the gated layer: most name an achievement id (from
 *     src/achievements.js's ACHIEVEMENTS table) that must be unlocked before they can be
 *     equipped; a couple carry no `unlockedBy` and are free like palettes.
 *   - validateLook() is the one function server.js calls on every appearance change. It
 *     NEVER trusts a client's claim to own an accessory, and it NEVER throws — malformed
 *     input degrades to a safe default look, never an error state.
 */
(function (root, factory) {
  // UMD: Node gets module.exports, a plain <script> gets window.Customization. Nothing else.
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Customization = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  /** Recursively freeze a value so no caller can reach into a shared table. */
  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  // ======================================================================
  // palette table — curated combinations, not a raw 360° picker.
  // Every entry is available to every player from the start (the free baseline layer).
  // Trim generally runs darker/more saturated than body for a cohesive two-tone look;
  // a few entries pick an independent trim hue for deliberate contrast.
  // ======================================================================

  var PALETTES = deepFreeze([
    { id: 'moss', name: 'Moss', bodyHue: 96, trimHue: 108 },
    { id: 'clay', name: 'Clay', bodyHue: 18, trimHue: 24 },
    { id: 'dusk', name: 'Dusk', bodyHue: 258, trimHue: 270 },
    { id: 'honeycomb', name: 'Honeycomb', bodyHue: 42, trimHue: 32 },
    { id: 'slate', name: 'Slate', bodyHue: 205, trimHue: 212 },
    { id: 'ember', name: 'Ember', bodyHue: 8, trimHue: 350 },
    { id: 'sage', name: 'Sage', bodyHue: 120, trimHue: 132 },
    { id: 'plum', name: 'Plum', bodyHue: 288, trimHue: 300 },
    { id: 'wheatfield', name: 'Wheatfield', bodyHue: 50, trimHue: 40 },
    { id: 'tide', name: 'Tide', bodyHue: 188, trimHue: 198 },
    { id: 'rust', name: 'Rust', bodyHue: 14, trimHue: 6 },
    { id: 'lichen', name: 'Lichen', bodyHue: 84, trimHue: 150 },
    { id: 'twilight', name: 'Twilight', bodyHue: 240, trimHue: 228 },
    { id: 'coral', name: 'Coral', bodyHue: 355, trimHue: 20 },
    { id: 'pine', name: 'Pine', bodyHue: 150, trimHue: 160 },
    { id: 'sandstone', name: 'Sandstone', bodyHue: 34, trimHue: 44 },
    { id: 'orchid', name: 'Orchid', bodyHue: 306, trimHue: 318 },
    { id: 'steel', name: 'Steel', bodyHue: 212, trimHue: 220 },
    { id: 'meadow', name: 'Meadow', bodyHue: 104, trimHue: 92 },
    { id: 'russet', name: 'Russet', bodyHue: 22, trimHue: 12 },
    { id: 'lavender', name: 'Lavender', bodyHue: 264, trimHue: 250 },
    { id: 'marsh', name: 'Marsh', bodyHue: 140, trimHue: 128 },
    { id: 'sunburst', name: 'Sunburst', bodyHue: 46, trimHue: 28 },
    { id: 'frost', name: 'Frost', bodyHue: 196, trimHue: 180 },
    { id: 'berry', name: 'Berry', bodyHue: 330, trimHue: 342 },
    { id: 'olive', name: 'Olive', bodyHue: 72, trimHue: 60 },
    { id: 'indigo', name: 'Indigo', bodyHue: 246, trimHue: 260 },
    { id: 'terracotta', name: 'Terracotta', bodyHue: 16, trimHue: 30 },
    { id: 'seafoam', name: 'Seafoam', bodyHue: 168, trimHue: 178 },
    { id: 'amethyst', name: 'Amethyst', bodyHue: 276, trimHue: 288 }
  ]);

  // ======================================================================
  // accessory catalog — a small set of layered cosmetics across 3 slots.
  // Most name an achievement id (verbatim from src/achievements.js's ACHIEVEMENTS
  // table) that must be unlocked before the accessory can be equipped; a couple carry
  // no `unlockedBy` and are free, like the palettes.
  // ======================================================================

  var ACCESSORIES = deepFreeze([
    { id: 'plain-cap', name: 'Plain Cap', slot: 'hat' },
    { id: 'travel-scarf', name: 'Travel Scarf', slot: 'scarf' },
    { id: 'gardeners-hat', name: "Gardener's Hat", slot: 'hat', unlockedBy: 'tinkerer' },
    { id: 'kiln-apron', name: 'Kiln-Scorched Apron', slot: 'cloak', unlockedBy: 'artificer' },
    { id: 'homestead-scarf', name: 'Homestead Scarf', slot: 'scarf', unlockedBy: 'homesteader' },
    { id: 'barons-cloak', name: "Baron's Cloak", slot: 'cloak', unlockedBy: 'land-baron' },
    { id: 'slayers-hood', name: "Slayer's Hood", slot: 'hat', unlockedBy: 'slayer' },
    { id: 'ascendant-crown', name: "Ascendant's Crown", slot: 'hat', unlockedBy: 'ascendant' },
    { id: 'wanderers-scarf', name: "Wanderer's Scarf", slot: 'scarf', unlockedBy: 'wayfarer' },
    { id: 'smiths-mantle', name: "Master Smith's Mantle", slot: 'cloak', unlockedBy: 'master-smith' },
    // ---- vanity row: bought with pending STRATUM, never earned by achievements.
    // Pure cosmetics (zero stats) and a real burn sink: the price funnels through
    // token-sink.js's splitBurn like every other sink. `priceStratum` is whole units.
    { id: 'gilded-band', name: 'Gilded Band', slot: 'hat', priceStratum: 100 },
    { id: 'ember-cloak', name: 'Ember Cloak', slot: 'cloak', priceStratum: 250 },
    { id: 'starlight-scarf', name: 'Starlight Scarf', slot: 'scarf', priceStratum: 500 },
    // ---- suit-tech row: space-faring colonist gear. Same three gates as the rest
    // (free baseline, achievement unlocks, STRATUM-priced vanity) — the slots are
    // what is new, not the economy around them.
    { id: 'dust-visor', name: 'Dust Visor', slot: 'visor' },
    { id: 'surveyor-visor', name: 'Surveyor Visor', slot: 'visor', unlockedBy: 'wayfarer' },
    { id: 'eclipse-visor', name: 'Eclipse Visor', slot: 'visor', priceStratum: 150 },
    { id: 'survey-pack', name: 'Survey Pack', slot: 'pack' },
    { id: 'o2-rig', name: 'O2 Rig', slot: 'pack', unlockedBy: 'homesteader' },
    { id: 'ion-thruster', name: 'Ion Thruster', slot: 'pack', priceStratum: 300 },
    { id: 'landing-patch', name: 'Landing Patch', slot: 'patch' },
    { id: 'void-patch', name: 'Void Patch', slot: 'patch', unlockedBy: 'slayer' },
    { id: 'goldleaf-insignia', name: 'Goldleaf Insignia', slot: 'patch', priceStratum: 400 }
  ]);

  var SLOTS = deepFreeze(['hat', 'cloak', 'scarf', 'visor', 'pack', 'patch']);
  var DEFAULT_PALETTE_ID = PALETTES[0].id;

  // ======================================================================
  // lookups
  // ======================================================================

  /** Palette record for an id, or null. Never throws, never mutates. */
  function paletteOf(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < PALETTES.length; i++) if (PALETTES[i].id === id) return PALETTES[i];
    return null;
  }

  /** Accessory record for an id, or null. Never throws, never mutates. */
  function accessoryOf(id) {
    if (typeof id !== 'string') return null;
    for (var i = 0; i < ACCESSORIES.length; i++) if (ACCESSORIES[i].id === id) return ACCESSORIES[i];
    return null;
  }

  /** Accessory id unlocked by an achievement id, or null when it grants none / unknown. */
  function cosmeticFor(achievementId) {
    if (typeof achievementId !== 'string') return null;
    for (var i = 0; i < ACCESSORIES.length; i++) {
      if (ACCESSORIES[i].unlockedBy === achievementId) return ACCESSORIES[i].id;
    }
    return null;
  }

  /** True when knownIds (array or Set of achievement ids) contains id. Never throws. */
  function hasId(knownIds, id) {
    if (!knownIds) return false;
    if (typeof knownIds.has === 'function') { try { return !!knownIds.has(id); } catch (e) { return false; } }
    if (Array.isArray(knownIds)) return knownIds.indexOf(id) !== -1;
    return false;
  }

  /**
   * True when accessoryId is available to a player holding unlockedAchievementIds
   * (array or Set, whatever shape achievements.js's unlockedIds()/evaluate() already
   * hand back). A free accessory (no unlockedBy) is always available. Never throws.
   */
  function isUnlocked(accessoryId, unlockedAchievementIds) {
    var a = accessoryOf(accessoryId);
    if (!a) return false;
    if (typeof a.unlockedBy !== 'string') return true;     // free cosmetic layer
    return hasId(unlockedAchievementIds, a.unlockedBy);
  }

  /**
   * STRATUM price of a vanity accessory, or 0 when it isn't bought with STRATUM
   * (free, achievement-gated, or unknown id). Whole units, never negative.
   */
  function vanityPrice(accessoryId) {
    var a = accessoryOf(accessoryId);
    if (!a || typeof a.priceStratum !== 'number' || !(a.priceStratum > 0)) return 0;
    return Math.floor(a.priceStratum);
  }

  /** True when the id names a vanity (STRATUM-priced) accessory. Never throws. */
  function isVanity(accessoryId) {
    return vanityPrice(accessoryId) > 0;
  }

  /**
   * Validate a vanity purchase: the accessory must exist, be vanity-priced, not
   * already owned, and affordable from `pending`. Returns { ok, price, error }.
   * Never mutates anything — the caller applies the ledger change. `ownedIds`
   * is an array/Set/map of already-bought vanity ids (any shape hasId() reads).
   */
  function validateVanityBuy(accessoryId, pending, ownedIds) {
    if (!isVanity(accessoryId)) return { ok: false, price: 0, error: 'not for sale' };
    if (hasId(ownedIds, accessoryId)) return { ok: false, price: 0, error: 'already owned' };
    var price = vanityPrice(accessoryId);
    if (typeof pending !== 'number' || !isFinite(pending) || Math.floor(pending) < price) {
      return { ok: false, price: price, error: 'cannot afford' };
    }
    return { ok: true, price: price, error: null };
  }

  /** A safe, always-valid look: the first palette, no accessories equipped. */
  function defaultLook() {
    return { paletteId: DEFAULT_PALETTE_ID, hat: null, cloak: null, scarf: null, visor: null, pack: null, patch: null };
  }

  /**
   * Sanitize a requested `{paletteId, hat, cloak, scarf}` look against a player's actual
   * unlocked-achievement state AND bought vanity set. Never trusts the client's claim
   * to own an accessory: a slot is kept only when it names an accessory that exists,
   * sits in that slot, and is unlocked for this player (achievement) or bought
   * (vanity, via `ownedVanityIds`, optional for backward compatibility) — everything
   * else silently drops to null. Malformed input degrades to defaultLook(), never
   * an error. Always returns a fresh object; never mutates `requested`.
   */
  function validateLook(requested, unlockedAchievementIds, ownedVanityIds) {
    var out = defaultLook();
    if (!requested || typeof requested !== 'object') return out;

    var p = paletteOf(requested.paletteId);
    out.paletteId = p ? p.id : DEFAULT_PALETTE_ID;

    for (var i = 0; i < SLOTS.length; i++) {
      var slot = SLOTS[i];
      var reqId = requested[slot];
      if (typeof reqId !== 'string' || !reqId) continue;
      var a = accessoryOf(reqId);
      if (!a || a.slot !== slot) continue;
      if (isVanity(a.id)) {
        if (!hasId(ownedVanityIds, a.id)) continue;
      } else if (!isUnlocked(a.id, unlockedAchievementIds)) continue;
      out[slot] = a.id;
    }
    return out;
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    ALL_PALETTES: PALETTES,          // all curated palettes (frozen).
    ALL_ACCESSORIES: ACCESSORIES,    // all accessories across every slot (frozen).
    SLOTS: SLOTS,                    // the small fixed slot set (frozen).
    DEFAULT_PALETTE_ID: DEFAULT_PALETTE_ID,
    paletteOf: paletteOf,            // palette record for an id, or null.
    accessoryOf: accessoryOf,        // accessory record for an id, or null.
    cosmeticFor: cosmeticFor,        // accessory id an achievement id unlocks, or null.
    isUnlocked: isUnlocked,          // whether an accessory is available to equip.
    vanityPrice: vanityPrice,        // STRATUM price of a vanity accessory, else 0.
    isVanity: isVanity,              // true for STRATUM-priced accessories.
    validateVanityBuy: validateVanityBuy, // { ok, price, error } for a vanity purchase.
    defaultLook: defaultLook,        // a safe default look (fresh object).
    validateLook: validateLook       // sanitize a requested look against unlocked state.
  };
});
