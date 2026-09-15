/**
 * ambient-combat.js — the Sanctuary-map combat model for STRATUM's cozy pivot
 * (ROADMAP_COZY.md, Phase 1).
 *
 * WHY THIS FILE EXISTS
 *   Frontier maps keep world.js's existing combat: click to strike, wind-ups to dodge,
 *   real crits, real danger. Sanctuary maps use THIS instead: no click, no timing, no
 *   telegraph to read. A creature near a player just slowly loses HP on a tick — being
 *   there is the whole input. Loot and XP still flow through world.js's existing
 *   `grantLoot`/`awardXp`, this module only decides WHO gets ticked, for how much, and
 *   caps how much a player can ever lose to it.
 *
 * CONTRACT
 *   - Dependency-free. No require(), no DOM, no I/O anywhere (not even at top level).
 *   - Dual-target UMD: `module.exports = {...}` under Node, `window.AmbientCombat = {...}`
 *     when loaded as a plain <script>. Detection is a bare `typeof module` check.
 *   - Fully pure and deterministic GIVEN a `rand` function: pass Math.random in
 *     production, an injectable PRNG in tests (mirrors terrain.js's `rollLoot(sp, rand)`
 *     precedent). No Date.now() — time is always passed in as `now`/`lastTickAt`.
 *     Every helper returns fresh objects and never mutates its arguments.
 *   - This module does not know about sockets, SQLite, or world.js's Map/Set state. It
 *     answers one question — "what does one tick between a player and a creature within
 *     range do" — and leaves placement/broadcast/persistence to the integrator, exactly
 *     like world.js's own `damageRoll`/`applyResist` (terrain.js) stay separate from the
 *     stateful `World` class that calls them.
 *
 * NOT WIRED YET. See ROADMAP_COZY.md's phased build order — this lands after Phase 0
 * (the `tone` field on T.MAPS) so world.js's tick() has something to branch on.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else if (root) root.AmbientCombat = api;
})(typeof self !== 'undefined' ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  function deepFreeze(v) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) {
      Object.freeze(v);
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) deepFreeze(v[k]);
    }
    return v;
  }

  // ======================================================================
  // tunables — deliberately gentle; see ROADMAP_COZY.md's open questions for
  // how these get playtested rather than spec'd once and forgotten
  // ======================================================================

  var TUNE = deepFreeze({
    range: 3,              // tiles: how close counts as "near" (mirrors world.js ATTACK_RANGE)
    tickMs: 2500,          // how often a tick can fire between one player and one creature
    playerDmgPerTick: 4,   // fixed, no variance, no crits — ambient means no minigame
    creatureDmgPerTick: 1, // much softer than playerDmgPerTick: you're meant to win passively
    hpFloorFrac: 0.20,     // a player's HP never drops below this fraction of max from ambient combat
    creatureRegenPerMs: 0  // Sanctuary creatures don't need world.js's wound-regen delay; they're gentle throughout
  });

  // ======================================================================
  // one tick
  // ======================================================================

  /**
   * Is `a` within ambient range of `b`? Both are {x,y}. Pure distance check, no state.
   */
  function inRange(a, b, range) {
    if (!a || !b || !isNum(a.x) || !isNum(a.y) || !isNum(b.x) || !isNum(b.y)) return false;
    var r = isNum(range) ? range : TUNE.range;
    var dx = a.x - b.x, dy = a.y - b.y;
    return (dx * dx + dy * dy) <= r * r;
  }

  /**
   * Has enough time passed since the last tick between this player/creature pair to fire
   * another one? `lastTickAt` is 0/undefined for "never yet" (always ready).
   */
  function tickReady(lastTickAt, now, tickMs) {
    if (!isNum(now)) return false;
    var interval = isNum(tickMs) ? tickMs : TUNE.tickMs;
    return !isNum(lastTickAt) || (now - lastTickAt) >= interval;
  }

  /**
   * Resolve one ambient tick between a player and a creature already confirmed in range
   * and ready (call `inRange`/`tickReady` first — this function does not re-check them,
   * it only does the damage math, so it stays trivially testable on its own).
   *
   * Inputs (both plain data, never mutated):
   *   player   { hp, maxHp }
   *   creature { hp, maxHp }
   *
   * Returns a fresh { player: {hp, maxHp}, creature: {hp, maxHp}, creatureDied: bool }.
   * The player's hp never drops below `hpFloorFrac * maxHp` from this function alone —
   * ambient combat can graze you, it cannot ever be how you die on a Sanctuary map.
   */
  function resolveTick(player, creature, tune) {
    var t = tune || TUNE;
    var pMax = isNum(player && player.maxHp) ? player.maxHp : 1;
    var pHp = isNum(player && player.hp) ? player.hp : pMax;
    var cMax = isNum(creature && creature.maxHp) ? creature.maxHp : 1;
    var cHp = isNum(creature && creature.hp) ? creature.hp : cMax;

    var nextCHp = Math.max(0, cHp - t.playerDmgPerTick);
    var creatureDied = nextCHp <= 0;

    var floor = pMax * t.hpFloorFrac;
    var nextPHp = creatureDied ? pHp : Math.max(floor, pHp - t.creatureDmgPerTick);

    return {
      player: { hp: nextPHp, maxHp: pMax },
      creature: { hp: nextCHp, maxHp: cMax },
      creatureDied: creatureDied
    };
  }

  /**
   * Convenience: given a player, a list of nearby creatures, and each pair's last-tick
   * timestamp (caller-supplied map keyed however the integrator likes), returns which
   * (player, creature) pairs are due a tick right now — pure filter, no math, no mutation.
   * The integrator calls `resolveTick` on each pair this returns and persists the result.
   */
  function dueTicks(player, creatures, lastTickAtFor, now, tune) {
    var t = tune || TUNE;
    var out = [];
    if (!player || !Array.isArray(creatures)) return out;
    for (var i = 0; i < creatures.length; i++) {
      var c = creatures[i];
      if (!inRange(player, c, t.range)) continue;
      var last = lastTickAtFor ? lastTickAtFor(c) : 0;
      if (!tickReady(last, now, t.tickMs)) continue;
      out.push(c);
    }
    return out;
  }

  // ======================================================================
  // exports
  // ======================================================================

  return {
    TUNE: TUNE,
    inRange: inRange,
    tickReady: tickReady,
    resolveTick: resolveTick,
    dueTicks: dueTicks
  };
});
