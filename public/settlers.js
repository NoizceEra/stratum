/**
 * settlers.js — Landing Zone Alpha's colonist settlement: who lives there and what
 * they say.
 *
 * WHY THIS FILE EXISTS
 *   Hotkeys open every panel, but a new colonist dropped onto an empty planet has no
 *   reason to press any of them. Three settlers camped by the spawn fire give the
 *   first session a face: a guide who mirrors your current quest, a quartermaster
 *   who opens craft/structures for you, and an archivist who explains STRATUM and the
 *   wallet. Talking is tap/click — the same gesture as harvesting — so touch players
 *   get the menus without ever finding a hotkey.
 *
 * CONTRACT
 *   - Dependency-free UMD. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.Settlers = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic: no Date.now(), no Math.random(), no globals written.
 *     Every helper returns fresh objects and NEVER mutates its arguments.
 *   - Positions are camp-relative offsets, NOT world tiles: the client resolves the
 *     camp anchor to a dry tile near spawn (same first-dry-candidate pattern as the
 *     landmark resolver in game.js) and adds these offsets. Settlers only ever exist
 *     on map 0.
 *   - Dialogue is informational only — lines and action keys, no game state. Action
 *     keys ('guide','craft','idle','wallet','travel','map','close') are mapped to the
 *     existing panel toggles by the client; this module never opens anything.
 *   - `talk()` never throws and never returns undefined: unknown npc ids give null,
 *     malformed ctx gives the generic greeting.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.Settlers = api;
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

  function isStr(s) { return typeof s === 'string' && s.length > 0; }

  // ======================================================================
  // the settlers — camp-relative [dx, dy] from the fire, map 0 only
  // ======================================================================

  var SETTLERS = deepFreeze([
    {
      id: 'sable', name: 'SABLE', role: 'Landing Guide',
      map: 0, dx: 0, dy: -2,
      body: '#c8b28a', trim: '#7a9e5f',
      blurb: 'First boots on Stratum, ten seasons back. She points new colonists at work.'
    },
    {
      id: 'dray', name: 'DRAY', role: 'Quartermaster',
      map: 0, dx: 2, dy: 1,
      body: '#9a8a6a', trim: '#b6543f',
      blurb: 'Keeps the camp fabricator hot. Feed him wood and ore, get gear back.'
    },
    {
      id: 'ilo', name: 'ILO', role: 'Archivist',
      map: 0, dx: -2, dy: 1,
      body: '#8a9ec8', trim: '#c9a55c',
      blurb: 'Tracks every gram shipped to Earth and every STRATUM owed for it.'
    }
  ]);

  /** Scenery around the fire, same offset space: tents + crates, decor only. */
  var CAMP_SPOTS = deepFreeze({
    fire: [0, 0],
    tents: [[-4, -3], [4, -3], [-4, 3]],
    crates: [[3, -2], [-3, 2]]
  });

  /** Action keys the client may map to panel toggles. Anything else is ignored. */
  var ACTIONS = deepFreeze(['guide', 'craft', 'idle', 'wallet', 'travel', 'map', 'tithe', 'close']);

  // ======================================================================
  // lookups
  // ======================================================================

  /** Settler record for an id, or null. Never throws. */
  function settlerById(id) {
    if (!isStr(id)) return null;
    for (var i = 0; i < SETTLERS.length; i++) {
      if (SETTLERS[i].id === id) return SETTLERS[i];
    }
    return null;
  }

  /** True for a known action key. */
  function isAction(a) {
    if (!isStr(a)) return false;
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i] === a) return true;
    }
    return false;
  }

  /** Safe non-negative integer read of a ctx field; garbage reads as 0. */
  function num(ctx, key) {
    var v = ctx ? ctx[key] : 0;
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
  }

  /** Safe quest id read of ctx; anything but a non-empty string reads as null. */
  function questId(ctx) {
    var q = ctx ? ctx.activeQuestId : null;
    return isStr(q) ? q : null;
  }

  // ======================================================================
   // dialogue — one fresh talk object per call: { name, role, line, actions }
  // Sable is the quest mirror: sableLine() is the SOLE owner of her Sable line;
  // the quest rail (Quests hint / StratumHud.setQuest) is the sole HUD owner —
  // no duplicate Sable text exists outside this one function.
  // ======================================================================

  function sableLine(q, done, total) {
    if (q === null && done >= total && total > 0) {
      return 'The whole first week, done. The world is yours now, colonist — land never resets, provisions always do. Ilo tracks what you ship; Dray keeps you geared.';
    }
    switch (q) {
      case 'harvest': return 'Fresh off the dropship? Good. Walk to a tree or an ore seam and strike it — left-click, or just tap it. Everything starts with what you pull out of the ground.';
      case 'claim': return 'You have materials. Now ground to stand on: left-click open land to stake your claim. Permanent. Nobody can ever take it from you — that is the whole promise of this place.';
      case 'kill': return 'The fauna objects to sharing. Find a beast and put it down — watch your life bar, and run early rather than late. Dray can arm you if you are still on flint.';
      case 'craft': return 'Dray\u2019s fabricator is right there — open it and build something from what you extracted. Even opening it counts as starting, the camp keeps score.';
      case 'upgrade': return 'Flint was Earth-issue charity. Copper tools — 3 wood, 2 ore — harvest more per swing. Dray, second word, no waiting.';
      case 'travel': return 'This acre is the doorway, not the house. Open travel and see another sector — Ashen Hollow for ore, the Sunken Shelf if you like a fight for dry land.';
      case 'level': return 'Last step of the first week: rank up. Keep clearing hostiles until you hit rank 2, then you are a colonist in full, not just a passenger.';
      default: return 'New boots. Here is the whole colony in one breath: harvest, claim land, clear beasts, build gear. I will walk you through it, one job at a time.';
    }
  }

  function drayLine(q, pending) {
    if (q === 'craft' || q === 'upgrade') {
      return 'Fabricator\u2019s hot. Wood and ore in, gear out — copper tools first, always. Shift-click a recipe to build all you can afford at once.';
    }
    if (q === 'claim') return 'Claim land first, then come back — structures need YOUR ground under them. Kiln turns ore into gold while you sleep. That is the whole economy.';
    if (pending > 0) return 'You have STRATUM pending, I can smell it. That is Ilo\u2019s department, not mine — but spend the gold before you convert it, gear beats numbers.';
    return 'Quartermaster Dray. I turn trees into tools and ore into armour. Salvage mode breaks gear back down for half its cost when you mis-click.';
  }

  function iloLine(q, pending, done, total) {
    if (pending >= 50) {
      return 'Your ledger is heavy — ' + pending + ' STRATUM pending. SHIP TO EARTH sends it toward the colony quota, CLAIM STRATUM sends it to your own wallet. Both take a small fee; the quota feeds everyone\u2019s yield.';
    }
    if (pending > 0) {
      return pending + ' STRATUM pending so far. Keep working — claims clear a floor first, so small balances wait. Shipping to Earth counts from the first gram.';
    }
    if (q === null && done >= total && total > 0) {
      return 'First week complete, and the ledger knows your name. Hold STRATUM in your wallet for a yield tier, ship it for the colony quota — holding helps you, shipping helps everyone.';
    }
    return 'Archivist Ilo. Every gram you ship to Earth is burned into the colony quota, and the quota raises everyone\u2019s yield. Connect a wallet when you want to claim STRATUM for yourself — play needs no wallet at all.';
  }

  /**
   * Talk to a settler. `ctx` is { activeQuestId, done, total, tokenPending } —
   * all optional; garbage reads as a fresh colonist with nothing pending.
   * Returns { name, role, line, actions:[{label, do}] } or null for unknown ids.
   */
  function talk(npcId, ctx) {
    try {
      var s = settlerById(npcId);
      if (!s) return null;
      var q = questId(ctx);
      var done = num(ctx, 'done'), total = num(ctx, 'total'), pending = num(ctx, 'tokenPending');
      var line, actions;
      if (s.id === 'sable') {
        line = sableLine(q, done, total);
        actions = [
          { label: 'SHOW ME (' + (q ? q.toUpperCase() : 'START') + ')', do: questAction(q) },
          { label: 'TITHE — 50000 STRATUM', do: 'tithe' },
          { label: 'READ THE GUIDE', do: 'guide' },
          { label: 'FAREWELL', do: 'close' }
        ];
      } else if (s.id === 'dray') {
        line = drayLine(q, pending);
        actions = [
          { label: 'OPEN FABRICATOR', do: 'craft' },
          { label: 'OPEN STRUCTURES', do: 'idle' },
          { label: 'TITHE — 50000 STRATUM', do: 'tithe' },
          { label: 'FAREWELL', do: 'close' }
        ];
      } else {
        line = iloLine(q, pending, done, total);
        actions = [
          { label: 'CONNECT WALLET', do: 'wallet' },
          { label: 'TITHE — 50000 STRATUM', do: 'tithe' },
          { label: 'READ THE GUIDE', do: 'guide' },
          { label: 'FAREWELL', do: 'close' }
        ];
      }
      return { name: s.name, role: s.role, line: line, actions: actions };
    } catch (e) { return null; }
  }

  /** Which panel best serves an active quest id — Sable's first button. */
  function questAction(q) {
    switch (q) {
      case 'craft':
      case 'upgrade': return 'craft';
      case 'travel': return 'travel';
      case 'kill':
      case 'level': return 'map';
      default: return 'close';
    }
  }

  return {
    SETTLERS: SETTLERS,           // all 3 settler records (frozen).
    CAMP_SPOTS: CAMP_SPOTS,       // fire/tents/crates offsets (frozen).
    ACTIONS: ACTIONS,             // legal action keys (frozen).
    settlerById: settlerById,     // record for an id, or null.
    isAction: isAction,           // true for a known action key.
    talk: talk,                   // { name, role, line, actions } or null.
    questAction: questAction      // panel key for a quest id.
  };
});
