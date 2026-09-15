/**
 * test-combat.js — STRATUM's combat contract, proven end to end.
 *
 * Two halves, because combat has two kinds of truth:
 *
 *   SIM   — the same modules the server runs (world.js + public/terrain.js) driven
 *           in-process. Behaviour that needs a controlled setup lives here: the charge,
 *           the pack call, the wind-up dodge window, the water rule, the loot tables,
 *           the level curve, tier-scaled respawn clocks.
 *
 *   LIVE  — a REAL server, spawned by this file on an EPHEMERAL port (never 8090) with
 *           its own throwaway DB under data/ and STRATUM_RESPAWN_SCALE=0.02, driven by
 *           REAL WebSocket clients. Everything a player can actually observe is asserted
 *           here: aggro, kills, loot, XP, level, respawn at home, the leash, variance,
 *           crits, wind-ups, and that no creature ever stands in water.
 *
 *   node test-combat.js
 *
 * No test framework, no dependencies. Exits non-zero if anything fails.
 */
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const T = require('./public/terrain.js');
const { World, ATTACK_RANGE, MODE, PHASE, MON_DEAGGRO } = require('./world.js');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RESOURCES = ['wood', 'ore', 'herb', 'crystal'];

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '   -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }
function note(t) { console.log('        ' + t); }

// ===========================================================================
// SIM — the modules the server runs, driven directly
// ===========================================================================

function mkWorld() {
  const db = { exec() {}, prepare() { return { run() {}, all() { return []; } }; } };
  return new World(db);
}
/** A World with every monster home near a map's spawn materialised. */
function simWorld(map) {
  const w = mkWorld();
  const sp = T.spawnPoint(map);
  w.activate(map, sp.x, sp.y);
  return w;
}
function byRole(w, map, role) {
  for (const m of w.monById.values()) if (m.map === map && m.sp.role === role) return m;
  return null;
}
function allByRole(w, map, role) {
  const out = [];
  for (const m of w.monById.values()) if (m.map === map && m.sp.role === role) out.push(m);
  return out;
}
function mkPlayer(x, y, map, key) {
  return {
    key, name: key, map, x, y, hp: 100, maxHp: 100, atk: 7, kills: 0,
    inv: { wood: 0, ore: 0, herb: 0, crystal: 0 }, dead: false
  };
}
/** A dry (non-water, non-void, in-bounds) offset from a point, or null. */
function dryOffset(map, x, y, dist) {
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12;
    const qx = x + Math.cos(a) * dist, qy = y + Math.sin(a) * dist;
    if (qx < 4 || qy < 4 || qx > T.W - 4 || qy > T.H - 4) continue;
    const b = T.baseTypeFor(map, Math.floor(qx), Math.floor(qy));
    if (b !== T.ID.WATER && b !== T.ID.VOID) return { x: qx, y: qy };
  }
  return null;
}
function lcg(seed) {
  let s = seed >>> 0;
  return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
/** A dry coastal tile — where monster homes sit next to water. */
function coastPoint(map) {
  for (let y = 48; y < T.H - 48; y += 24) {
    for (let x = 48; x < T.W - 48; x += 24) {
      if (T.baseTypeFor(map, x, y) === T.ID.WATER) continue;
      let near = false;
      for (let dy = -4; dy <= 4 && !near; dy++) {
        for (let dx = -4; dx <= 4; dx++) if (T.baseTypeFor(map, x + dx, y + dy) === T.ID.WATER) { near = true; break; }
      }
      if (near) return { x, y };
    }
  }
  return null;
}
function median(a) { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; }

/**
 * Mirrors world.js's old (pre-cozy-pivot) tick() monster loop — every live monster gets
 * one stepMonster() call — but calls stepMonster() DIRECTLY rather than through tick(),
 * which now branches Sanctuary maps to ambientTick() instead. The archetype tests below
 * (kiter retreat, brute charge, pack call, wind-up dodge, shoreline chase) are about
 * stepMonster's own AI, not about which production map currently carries which tone —
 * map 1 is the only Frontier map and does not have every archetype (no kiter, no brute).
 * Returns {hits:[], calls:[]}, the same shape tick() returns those two fields as.
 *
 * Gates on MON_DEAGGRO exactly like tick() does — several archetype scenarios share one
 * long-lived World across sections, and without this gate a monster far from the CURRENT
 * section's player would still get stepped (and its state churned by Math.random() idle
 * wander, cooldowns, etc.) every time an EARLIER section called simStep for someone else.
 */
function simStep(w, players, now) {
  const out = { hits: [], calls: [] };
  for (const m of w.monsters.values()) {
    if (m.state !== 1) continue;
    let seen = false;
    for (const p of players) {
      if (p.dead || p.map !== m.map) continue;
      if (Math.abs(p.x - m.x) < MON_DEAGGRO && Math.abs(p.y - m.y) < MON_DEAGGRO) { seen = true; break; }
    }
    if (!seen) continue;
    w.stepMonster(m, players, now, out);
  }
  return out;
}

function simSection() {
  section('DATA CONTRACT — terrain.js stays dependency-free and additive');

  // --- every monster keeps the classic fields and gains form + tier ---------
  const wantMon = ['name', 'hp', 'atk', 'speed', 'aggro', 'respawnMs', 'form', 'tier', 'xp', 'dmgType', 'resist', 'lootTable', 'windupMs', 'cooldownMs'];
  let badField = null, speciesCount = 0, mapCount = 0;
  const forms = {}, roles = {}, tiers = {}, dmgTypes = {};
  for (const mid of Object.keys(T.SPECIES)) {
    mapCount++;
    for (const s of T.SPECIES[mid]) {
      speciesCount++;
      for (const f of wantMon) if (s[f] === undefined || s[f] === null) { badField = s.kind + '.' + f; break; }
      if (badField) break;
      if (typeof s.form !== 'string' || !s.form) { badField = s.kind + '.form'; break; }
      if (typeof s.tier !== 'number' || s.tier < 1) { badField = s.kind + '.tier'; break; }
      if (s.name !== s.kind) { badField = s.kind + '.name!==kind'; break; }
      if (T.DAMAGE_TYPES.indexOf(s.dmgType) < 0) { badField = s.kind + '.dmgType'; break; }
      for (const k of Object.keys(s.resist)) if (T.DAMAGE_TYPES.indexOf(k) < 0) { badField = s.kind + '.resist.' + k; break; }
      forms[s.form] = (forms[s.form] || 0) + 1;
      roles[s.role] = (roles[s.role] || 0) + 1;
      tiers[s.tier] = (tiers[s.tier] || 0) + 1;
      dmgTypes[s.dmgType] = (dmgTypes[s.dmgType] || 0) + 1;
    }
    if (badField) break;
  }
  ok(!badField, 'every species keeps name/hp/atk/speed/aggro/respawnMs and adds form+tier', badField);
  ok(speciesCount >= 6 && mapCount === 3, speciesCount + ' species across ' + mapCount + ' maps (need >=6 across 3)', speciesCount);
  ok(Object.keys(forms).length >= 6, 'every species names a body shape for the renderer', Object.keys(forms).length + ' distinct forms');
  const needRoles = ['kiter', 'brute', 'pack', 'spitter', 'tank', 'swarm'];
  const missing = needRoles.filter(r => !roles[r]);
  ok(missing.length === 0, 'all six archetypes exist: kiter, brute, pack, spitter, tank, swarm', missing.length ? missing : roles);
  ok(Object.keys(tiers).length >= 2, 'tiers vary — the respawn clock has something to scale with', tiers);
  ok(Object.keys(dmgTypes).length >= 2, 'species deal more than one damage type', dmgTypes);

  // --- every damage type is represented, and resistances are data -----------
  const allSp = [];
  for (const mid of Object.keys(T.SPECIES)) for (const s of T.SPECIES[mid]) allSp.push(s);
  const resistsCovered = T.DAMAGE_TYPES.every(dt => allSp.some(s => typeof s.resist[dt] === 'number'));
  ok(T.DAMAGE_TYPES.join(',') === 'physical,fire,ice', 'damage types are physical/fire/ice, exposed as data', T.DAMAGE_TYPES);
  ok(resistsCovered, 'per-species resistances cover all three damage types');
  ok(T.DEFAULT_DMG_TYPE === 'physical', 'a player default damage type is declared', T.DEFAULT_DMG_TYPE);

  // --- nodes keep the fields the harvester needs ---------------------------
  let nodeBad = null;
  for (const k of Object.keys(T.NODE_KINDS)) {
    const d = T.NODE_KINDS[k];
    if (d.yield === undefined || d.yields === undefined || d.hp === undefined || d.respawnMs === undefined) nodeBad = k;
  }
  ok(!nodeBad, 'every NODE_KINDS entry keeps yield/yields/hp/respawnMs', nodeBad);

  // --- terrain.js is browser-safe -----------------------------------------
  const src = fs.readFileSync(path.join(__dirname, 'public', 'terrain.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/\brequire\s*\(/.test(code) && !/\bimport\s+[\w{*]/.test(code), 'terrain.js contains no require()/import');
  ok(!/\bdocument\b|\bwindow\b\s*\.\s*\w+\s*=|localStorage/.test(code), 'terrain.js never touches the DOM');
  const fresh = (function () {
    const mod = { exports: {} };
    new Function('module', 'exports', src)(mod, mod.exports);
    return mod.exports;
  })();
  ok(fresh && fresh.SPECIES && fresh.homesNear && fresh.damageRoll, 'terrain.js loads standalone (browser-style) and exposes one object');

  // ---------------------------------------------------------------------
  section('SIM — species behave the way their archetype promises');

  const w0 = simWorld(0);
  const w1 = simWorld(1);
  // map 2's spawn sits in the middle of a continent: stand the world up on a coastline
  // instead, so there are homes next to water to bait monsters across.
  const w2 = mkWorld();
  const coast = coastPoint(2) || T.spawnPoint(2);
  w2.activate(2, coast.x, coast.y);
  ok(w0.monsters.size > 5, w0.monsters.size + ' monster homes materialised on map 0');

  // kiter retreats
  const kiter = byRole(w0, 0, 'kiter');
  if (!kiter) ok(false, 'a kiting skirmisher exists on map 0', kiter);
  else {
    const p = mkPlayer(kiter.x + 1.2, kiter.y, 0, 'SIM-KITER');
    const d0 = 1.2;
    let d = d0;
    for (let i = 0; i < 40; i++) { simStep(w0, [p], Date.now() + i * 100); d = Math.hypot(kiter.x - p.x, kiter.y - p.y); }
    ok(d >= kiter.sp.keepAway * 0.9 && d > d0 + 1, 'kiter (' + kiter.sp.kind + ') backs off to its stand-off range when closed on',
      { from: d0, to: +d.toFixed(2), keepAway: kiter.sp.keepAway });
  }

  // brute winds up, then charges much faster than it walks
  const brute = byRole(w0, 0, 'brute');
  if (!brute) ok(false, 'a charging brute exists on map 0');
  else {
    const spot = dryOffset(0, brute.x, brute.y, 9) || { x: brute.x + 9, y: brute.y };
    const p = mkPlayer(spot.x, spot.y, 0, 'SIM-BRUTE');
    const base = brute.sp.speed * 0.1;
    let maxStep = 0, sawWindup = false, sawDash = false;
    let prev = { x: brute.x, y: brute.y };
    for (let i = 0; i < 140; i++) {
      simStep(w0, [p], Date.now() + i * 100);
      const step = Math.hypot(brute.x - prev.x, brute.y - prev.y);
      if (brute.phase === PHASE.WINDUP) sawWindup = true;
      if (step > base * 1.8) sawDash = true;
      if (step > maxStep) maxStep = step;
      prev = { x: brute.x, y: brute.y };
    }
    ok(sawWindup, 'brute (' + brute.sp.kind + ') paws the ground before it commits');
    ok(sawDash && maxStep > base * 2, 'brute then dashes at ' + (maxStep / base).toFixed(1) + 'x walking speed', { maxStep: +maxStep.toFixed(3), base: +base.toFixed(3) });
  }

  // pack hunter calls allies that cannot see the player
  const pack = byRole(w0, 0, 'pack');
  const mates = allByRole(w0, 0, 'pack').filter(m => m !== pack);
  if (!pack || mates.length < 1) ok(false, 'a pack hunter and at least one same-species ally exist on map 0');
  else {
    const far = dryOffset(0, pack.x, pack.y, 16) || { x: pack.x + 16, y: pack.y };
    const called = mates.slice(0, 2);
    called.forEach((a, i) => {
      a.x = far.x + i * 1.5; a.y = far.y;
      a.hx = a.x; a.hy = a.y;                 // scenario: they den together
      a.mode = MODE.IDLE; a.calledBy = 0;
    });
    const p = mkPlayer(pack.x + 3, pack.y, 0, 'SIM-PACK');
    const allyDist = Math.hypot(called[0].x - p.x, called[0].y - p.y);
    let callEvents = [];
    for (let i = 0; i < 4; i++) {
      const ev = simStep(w0, [p], Date.now() + i * 100);
      if (ev.calls && ev.calls.length) callEvents = callEvents.concat(ev.calls);
    }
    const got = called[0].mode === MODE.CHASE && called[0].calledBy === pack.id;
    ok(allyDist > called[0].sp.aggro, 'the ally starts outside its own aggro range (' + allyDist.toFixed(1) + ' > ' + called[0].sp.aggro + ')');
    ok(got, 'pack hunter (' + pack.sp.kind + ') calls same-species allies inside its call radius', { calledBy: called[0].calledBy, mode: called[0].mode });
    ok(callEvents.length >= 1, 'the pack call is reported as an event', callEvents);
    ok(called.length < 2 || called[1].mode === MODE.CHASE, 'the second ally is called too', called[1] && called[1].mode);
  }

  // ranged spitter hits a target a melee creature never could
  const spit = byRole(w1, 1, 'spitter');
  const swar = byRole(w1, 1, 'swarm') || byRole(w1, 1, 'brute');
  if (!spit || !swar) ok(false, 'map 1 provides both a spitter and a melee creature');
  else {
    const spot = dryOffset(1, spit.x, spit.y, spit.sp.ranged - 2) || { x: spit.x + 7, y: spit.y };
    const p = mkPlayer(spot.x, spot.y, 1, 'SIM-SPIT');
    const hitDists = [];
    for (let i = 0; i < 60; i++) {
      const ev = w1.tick([p], Date.now() + i * 100);
      for (const h of ev.hits) if (h.id === spit.id) hitDists.push(Math.hypot(h.x - p.x, h.y - p.y));
    }
    ok(hitDists.length > 0 && Math.min(...hitDists) > 4, 'spitter (' + spit.sp.kind + ') lands blows from ' +
      (hitDists.length ? Math.min(...hitDists).toFixed(1) : '?') + ' tiles away — unreachable in melee', hitDists.length);

    const spot2 = dryOffset(1, swar.x, swar.y, 7) || { x: swar.x + 7, y: swar.y };
    const p2 = mkPlayer(spot2.x, spot2.y, 1, 'SIM-MELEE');
    const meleeDists = [];
    for (let i = 0; i < 90; i++) {
      const ev = w1.tick([p2], Date.now() + i * 100);
      for (const h of ev.hits) if (h.id === swar.id) meleeDists.push(Math.hypot(h.x - p2.x, h.y - p2.y));
    }
    ok(meleeDists.length > 0 && Math.max(...meleeDists) <= 3.5, 'melee (' + swar.sp.kind + ') can only strike inside ' +
      (meleeDists.length ? Math.max(...meleeDists).toFixed(1) : '?') + ' tiles', meleeDists.length);
  }

  // wind-up is a real dodge window: leave during the tell and nothing lands
  const swarms = allByRole(w0, 0, 'swarm');
  if (swarms.length < 2) ok(false, 'map 0 generates at least two swarmlings for the dodge test');
  else {
    const A = swarms[0];
    const p = mkPlayer(A.x + 1.2, A.y, 0, 'SIM-DODGE');
    let frozen = null, dodged = true, sawTell = false;
    for (let i = 0; i < 40 && !sawTell; i++) {
      const ev = simStep(w0, [p], Date.now() + i * 100);
      for (const h of ev.hits) if (h.id === A.id) { /* never mind, we want the tell first */ }
      if (A.phase === PHASE.WINDUP) { sawTell = true; frozen = { x: A.x, y: A.y }; }
    }
    ok(sawTell, 'a blow is telegraphed before it lands (phase=windup on the wire)', sawTell);
    if (sawTell) {
      const stillFrozen = Math.hypot(A.x - frozen.x, A.y - frozen.y) < 1e-6;
      const away = dryOffset(0, A.x, A.y, 30) || { x: A.x + 30, y: A.y };
      p.x = away.x; p.y = away.y;                       // step out of reach mid-tell
      for (let i = 0; i < 8; i++) {
        const ev = simStep(w0, [p], Date.now() + 4000 + i * 100);
        for (const h of ev.hits) if (h.id === A.id) dodged = false;
      }
      ok(stillFrozen, 'the attacker is rooted while winding up — the tell is the dodge window');
      ok(dodged, 'walking out during the wind-up makes the blow MISS');
    }
    const C = swarms[1];
    const pc = mkPlayer(C.x + 1.2, C.y, 0, 'SIM-STAND');
    let landed = false;
    for (let i = 0; i < 40; i++) {
      const ev = simStep(w0, [pc], Date.now() + i * 100);
      for (const h of ev.hits) if (h.id === C.id) landed = true;
    }
    ok(landed, 'standing still through the same wind-up takes the hit (the control case)');
  }

  // no creature ever stands in water or off the map, even chasing across it
  let waterViolations = 0, checked = 0, chased = 0, maxStray = 0;
  for (const w of [w0, w1, w2]) for (const m of w.monById.values()) {
    checked++;
    if (!w.canStand(m.map, m.x, m.y)) waterViolations++;
  }
  const ww = w2;
  let bait = null, baitWater = null, bestScore = 1e9, baitDist = 0;
  for (const m of ww.monById.values()) {
    const bx = Math.floor(m.x), by = Math.floor(m.y);
    let nb = 1e9, nw = null;
    for (let dy = -16; dy <= 16; dy++) for (let dx = -16; dx <= 16; dx++) {
      const tx = bx + dx, ty = by + dy;
      if (tx < 1 || ty < 1 || tx >= T.W - 1 || ty >= T.H - 1) continue;
      if (T.baseTypeFor(2, tx, ty) !== T.ID.WATER) continue;
      const d = Math.hypot(tx + 0.5 - m.x, ty + 0.5 - m.y);
      if (d < nb) { nb = d; nw = { x: tx + 0.5, y: ty + 0.5 }; }
    }
    if (!nw) continue;
    // prefer a shoreline this creature will actually try to cross — it has to be able to see us
    const score = ((nb + 4 <= m.sp.aggro) ? 0 : 1000) + nb;
    if (score < bestScore) { bestScore = score; bait = m; baitWater = nw; baitDist = nb; }
  }
  if (!bait) ok(false, 'map 2 has water next to a monster home to test the pathing rule');
  else {
    // stand on the far side of a lake from the monster: it must reach us without swimming
    const ux = (baitWater.x - bait.x) / (baitDist || 1), uy = (baitWater.y - bait.y) / (baitDist || 1);
    const p = mkPlayer(bait.x + ux * (baitDist + 3.5), bait.y + uy * (baitDist + 3.5), 2, 'SIM-WATER');
    const home = { x: bait.hx, y: bait.hy };
    let travel = 0, prev = { x: bait.x, y: bait.y };
    for (let i = 0; i < 300; i++) {
      simStep(ww, [p], Date.now() + i * 100);
      if (bait.mode === MODE.CHASE) chased++;
      travel += Math.hypot(bait.x - prev.x, bait.y - prev.y);
      prev = { x: bait.x, y: bait.y };
      maxStray = Math.max(maxStray, Math.hypot(bait.x - home.x, bait.y - home.y));
      for (const m of ww.monById.values()) {
        if (m.state !== 1) continue;
        checked++;
        if (!ww.canStand(m.map, m.x, m.y)) waterViolations++;
      }
    }
    note(bait.sp.kind + ' baited across a shoreline ' + baitDist.toFixed(1) + ' tiles from it: ' +
      chased + ' chasing ticks, ' + travel.toFixed(1) + ' tiles of movement, leash ' + bait.sp.leash);
    ok(chased > 0 && travel > 1, 'the baited creature actively tried to cross (' + chased + ' chasing ticks, ' +
      travel.toFixed(1) + ' tiles travelled)', { chased, travel: +travel.toFixed(1) });
    ok(waterViolations === 0, 'no creature ever entered water, void or the border (' + checked + ' position checks, ' +
      chased + ' chasing ticks)', waterViolations);
    ok(maxStray <= bait.sp.leash + 3, 'the leashed creature never wandered past its leash (' +
      maxStray.toFixed(1) + ' <= ' + (bait.sp.leash + 3) + ')', { maxStray: +maxStray.toFixed(1), leash: bait.sp.leash });
  }

  // ---------------------------------------------------------------------
  section('SIM — damage, loot, XP and the level curve');

  const rolls = [];
  for (let i = 0; i < 600; i++) rolls.push(T.damageRoll(10));
  const dmgVals = rolls.map(r => r.dmg);
  const distinct = new Set(dmgVals).size;
  const crits = rolls.filter(r => r.crit).length / rolls.length;
  const med = median(dmgVals);
  ok(distinct >= 4, 'damage varies (' + distinct + ' distinct values over 600 rolls: ' +
    [...new Set(dmgVals)].sort((a, b) => a - b).join(',') + ')', distinct);
  ok(Math.min(...dmgVals) >= 1, 'no blow rolls below the minimum damage', Math.min(...dmgVals));
  ok(crits > 0.15 && crits < 0.35, 'critical hits occur at the declared rate (' + (crits * 100).toFixed(1) + '% of 600)', crits);
  ok(Math.max(...dmgVals) >= med * 1.5, 'a crit is unmistakably bigger than an ordinary blow (max ' + Math.max(...dmgVals) + ' vs median ' + med + ')');

  const slag = T.SPECIES[1].find(s => s.kind === 'SLAG_WRETCH');
  const raw = 100;
  const fire = T.applyResist('fire', raw, slag), phys = T.applyResist('physical', raw, slag), ice = T.applyResist('ice', raw, slag);
  ok(fire < phys && ice > phys, 'resistances are real: ' + slag.kind + ' takes ' + fire + ' fire / ' + phys + ' physical / ' + ice + ' ice',
    { fire, physical: phys, ice });
  ok(Math.abs(T.applyResist('fire', 100, {}) - 100) < 1e-9, 'an unresistant target takes full damage');

  // loot tables: chance and quantity ranges honoured over many independent rolls
  let lootBad = null, lootDetail = [];
  const rnd = lcg(20240914);
  for (const s of allSp) {
    const counts = {}, qty = {}, N = 4000;
    for (let i = 0; i < N; i++) {
      const r = T.rollLoot(s, rnd);
      for (const k of Object.keys(r.grants)) {
        if (RESOURCES.indexOf(k) < 0) { lootBad = s.kind + ' drops a non-resource: ' + k; break; }
        counts[k] = (counts[k] || 0) + 1;
        qty[k] = qty[k] || { min: 1e9, max: 0 };
        qty[k].min = Math.min(qty[k].min, r.grants[k]);
        qty[k].max = Math.max(qty[k].max, r.grants[k]);
      }
      if (lootBad) break;
    }
    if (lootBad) break;
    for (const e of s.lootTable) {
      if (e.chance < 0 || e.chance > 1 || e.min < 1 || e.max < e.min) { lootBad = s.kind + ' bad entry'; break; }
      const rate = (counts[e.item] || 0) / N;
      if (Math.abs(rate - e.chance) > 0.06) { lootBad = s.kind + '/' + e.item + ' rate ' + rate.toFixed(3) + ' != ' + e.chance; break; }
      if (qty[e.item] && (qty[e.item].min < e.min || qty[e.item].max > e.max)) { lootBad = s.kind + '/' + e.item + ' qty ' + JSON.stringify(qty[e.item]) + ' outside ' + e.min + '-' + e.max; break; }
    }
    if (lootBad) break;
    if (s.lootTable[0].chance !== 1) { lootBad = s.kind + ' has no guaranteed drop'; break; }
    lootDetail.push(s.kind + ':' + s.lootTable.map(e => e.item + '@' + e.chance + 'x' + e.min + '-' + e.max).join('+'));
  }
  ok(!lootBad, 'every species rolls its loot table within chance and quantity ranges (' + lootDetail.length + ' species x4000 rolls)', lootBad);

  // respawn clocks scale with tier
  const t1 = T.respawnMsFor({ respawnMs: 60000, tier: 1 });
  const t2 = T.respawnMsFor({ respawnMs: 60000, tier: 2 });
  const t3 = T.respawnMsFor({ respawnMs: 60000, tier: 3 });
  ok(t1 < t2 && t2 < t3 && t1 === 60000, 'the respawn clock scales with tier: ' + [t1, t2, t3].join(' < '), [t1, t2, t3]);
  const realTiers = {};
  for (const s of allSp) realTiers[s.tier] = (realTiers[s.tier] || 0) + 1;
  ok(Object.keys(realTiers).length >= 2, 'real species span more than one tier', realTiers);

  // level curve
  let mono = true;
  for (let l = 1; l < 20; l++) { if (T.xpToNext(l + 1) <= T.xpToNext(l)) mono = false; }
  let hpMono = true, atkMono = true;
  for (let l = 1; l < 20; l++) {
    if (T.maxHpForLevel(l + 1) <= T.maxHpForLevel(l)) hpMono = false;
    if (T.attackForLevel(l + 1) < T.attackForLevel(l)) atkMono = false;
  }
  ok(mono, 'each level costs more XP than the last (' + [1, 2, 3, 4, 5].map(T.xpToNext).join(',') + '…)');
  ok(hpMono && atkMono && T.attackForLevel(1) === 7 && T.maxHpForLevel(1) === 100,
    'max HP and attack are derived from level (L1 ' + T.maxHpForLevel(1) + 'hp/' + T.attackForLevel(1) + 'atk)');
  const need = T.xpToNext(1) + T.xpToNext(2);
  ok(T.levelFromXp(need).level === 3 && T.levelFromXp(need - 1).level === 2, 'the XP->level curve is exact at its boundaries', [need, T.levelFromXp(need).level]);

  // killing through the real combat entry point: XP, loot, level, derived stats
  const tank = byRole(w0, 0, 'tank');
  if (!tank) ok(false, 'a tank exists on map 0 to kill');
  else {
    const p = mkPlayer(tank.x + 1, tank.y, 0, 'SIM-XP');
    const invBefore = Object.assign({}, p.inv);
    let killed = null, rolls2 = 0, crits2 = 0, xpSum = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      tank.state = 1; tank.mode = MODE.IDLE; tank.hp = tank.maxHp = tank.sp.hp;
      p.x = tank.x + 1; p.y = tank.y;
      for (let i = 0; i < 400 && !killed; i++) {
        p.nextSwing = 0;                              // the test may skip its own recovery
        const r = w0.attack(p, tank.id);
        if (r.err) break;
        rolls2++; if (r.crit) crits2++;
        if (r.killed) { killed = r; break; }
      }
      ok(!!killed && killed.killed, 'cycle ' + (cycle + 1) + ': the tank died to repeated attacks in ' + rolls2 + ' swings');
      if (killed) { xpSum += killed.xp; killed = null; }
    }
    const h = w0.hunters.get('SIM-XP');
    ok(xpSum === tank.sp.xp * 3, 'each kill awards the species XP to the killer only (' + xpSum + ')', xpSum);
    ok(h && h.xp === xpSum && h.level === 3, 'XP accumulates into levels (level ' + (h && h.level) + ' at ' + (h && h.xp) + 'xp)', h && { xp: h.xp, level: h.level });
    ok(p.maxHp === T.maxHpForLevel(3) && p.atk === T.attackForLevel(3) && p.maxHp > 100,
      'the level raised the killer\'s derived HP and attack (' + p.maxHp + 'hp / ' + p.atk + 'atk)');
    const gained = Object.keys(p.inv).filter(k => p.inv[k] > invBefore[k]);
    const legal = gained.every(k => tank.sp.lootTable.some(e => e.item === k));
    ok(gained.length > 0 && legal, 'the kill granted loot into the killer\'s inventory: ' +
      gained.map(k => '+' + (p.inv[k] - invBefore[k]) + ' ' + k).join(' '), { gained, legal });
    const totRolls = rolls2;
    ok(totRolls >= 6, 'the kill took many damage rolls (' + totRolls + ', ' + crits2 + ' crits)', totRolls);
  }

  // the swing rules themselves
  const victim = allByRole(w0, 0, 'swarm')[2] || allByRole(w0, 0, 'swarm')[0];
  if (victim) {
    const p = mkPlayer(victim.x + 1, victim.y, 0, 'SIM-RULES');
    p.nextSwing = 0;
    const a1 = w0.attack(p, victim.id);
    const a2 = w0.attack(p, victim.id);
    ok(a1.ok && !a1.killed, 'a swing inside reach lands', a1);
    ok(a2.err === 'recovering', 'you cannot swing again before your recovery ends', a2.err);
    p.x = victim.x + 60; p.nextSwing = 0;
    const a3 = w0.attack(p, victim.id);
    ok(a3.err === 'out of range', 'a swing out of reach is refused', a3.err);
    ok(ATTACK_RANGE === 3, 'attack range is still 3 tiles', ATTACK_RANGE);
    const a4 = w0.attack(p, 999999);
    ok(a4.err === 'no such creature', 'swinging at nothing is refused', a4.err);
  }
}

// ===========================================================================
// LIVE — a real server, real WebSocket clients, real wire
// ===========================================================================

function freePort() {
  return new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
function wipe(db) { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + s); } catch (e) {} } }
function waitReady(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stats' }, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (++tries > 120) return reject(new Error('server never came up on :' + port));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}
function statsGet(port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/api/stats' }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

class Client {
  constructor(tag, map) {
    this.tag = tag; this.map = map;
    this.msgs = []; this.waiters = [];
    this.monsSamples = 0; this.tileChecks = 0; this.waterViolations = [];
    this.deaths = 0; this.sawWindup = false; this.phasesSeen = {};
  }
  connect(port) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: '127.0.0.1', port, path: '/',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => {
        const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) return reject(new Error('bad accept key'));
        this.socket = socket; this.buf = Buffer.alloc(0);
        socket.on('data', d => this._feed(d));
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }
  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const txt = this.buf.subarray(off, off + len).toString('utf8');
      this.buf = this.buf.subarray(off + len);
      let m; try { m = JSON.parse(txt); } catch (e) { continue; }
      if (m.t === 'died') this.deaths++;
      if (m.t === 'mons') this._sampleMons(m);
      this.msgs.push(m);
      this.waiters = this.waiters.filter(w => { if (w.test(m)) { w.resolve(m); return false; } return true; });
    }
  }
  /**
   * Every monster position the server ever sends is checked against the terrain rule:
   * a creature may never stand on water, on void, or outside the map.
   */
  _sampleMons(m) {
    this.monsSamples++;
    const map = (m.map === undefined) ? this.map : m.map;
    for (const e of m.list) {
      this.tileChecks++;
      if (e[7] === PHASE.WINDUP) this.sawWindup = true;
      this.phasesSeen[e[7]] = (this.phasesSeen[e[7]] || 0) + 1;
      const tx = Math.floor(e[2]), ty = Math.floor(e[3]);
      if (tx < 1 || ty < 1 || tx >= T.W - 1 || ty >= T.H - 1) {
        this.waterViolations.push({ id: e[0], x: e[2], y: e[3], why: 'off-map' });
        continue;
      }
      const b = T.baseTypeFor(map, tx, ty);
      if (b === T.ID.WATER || b === T.ID.VOID) this.waterViolations.push({ id: e[0], x: e[2], y: e[3], tile: b });
    }
  }
  send(o) {
    const p = Buffer.from(JSON.stringify(o));
    const mask = crypto.randomBytes(4);
    let head;
    if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    const body = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
    this.socket.write(Buffer.concat([head, mask, body]));
  }
  waitFor(test, ms) {
    const hit = this.msgs.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout')); }, ms || 4000);
    });
  }
  /** Wait for a message that arrives AFTER this call — stale matches don't count. */
  waitNew(test, ms) {
    const from = this.msgs.length;
    const scan = () => { for (let i = from; i < this.msgs.length; i++) if (test(this.msgs[i])) return this.msgs[i]; return null; };
    const hit = scan();
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { test: () => { const r = scan(); if (r) { w.resolve(r); return true; } return false; }, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(this.tag + ': timeout(new)')); }, ms || 4000);
    });
  }
  pos() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'players' && m.you) return { x: m.you[0], y: m.you[1] };
    }
    return null;
  }
  async posReady(ms) {
    const t0 = Date.now();
    for (;;) {
      const p = this.pos();
      if (p) return p;
      if (Date.now() - t0 > (ms || 5000)) return null;
      await sleep(120);
    }
  }
  monsters() {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === 'mons') return this.msgs[i].list;
    return [];
  }
  monById(id) {
    for (const e of this.monsters()) if (e[0] === id) return e;
    return null;
  }
  inv() {
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.t === 'welcome' || (m.t === 'combat' && m.inv)) return m.inv;
    }
    return null;
  }
  /** Walk toward a tile in increments big enough to make progress, small enough to be legal. */
  async approach(tx, ty, within, budgetMs) {
    const t0 = Date.now();
    let d = Infinity;
    while (Date.now() - t0 < (budgetMs || 20000)) {
      const p = this.pos();
      if (!p) { await sleep(120); continue; }
      const dx = tx - p.x, dy = ty - p.y;
      d = Math.hypot(dx, dy);
      if (d <= within) return d;
      const step = Math.min(2, d);
      this.send({ t: 'move', x: Math.round(p.x + (dx / d) * step), y: Math.round(p.y + (dy / d) * step) });
      await sleep(150);
    }
    return d;
  }
  close() { try { this.socket.destroy(); } catch (e) {} }
}

function nearestHome(homes, x, y) {
  let best = null, bd = Infinity;
  for (const h of homes) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d < bd) { bd = d; best = h; }
  }
  return best ? Object.assign({ dist: bd }, best) : null;
}
function nearestHomes(map, x, y) { return T.homesNear(map, Math.round(x), Math.round(y), 2); }

/**
 * One duel: walk into reach and swing until the creature dies (or time runs out).
 * Returns {killed, rolls:[], msg}. Prefers attacking over closing, so the server's own
 * range rule is what decides when a swing lands.
 */
async function duel(A, id, st, budgetMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const p = A.pos();
    const m = A.monById(id);
    if (!p || !m) { await sleep(120); continue; }        // dead (or out of sight): wait
    const d = Math.hypot(m[2] - p.x, m[3] - p.y);
    if (d > 3.4) {
      const step = Math.min(2, d);
      A.send({ t: 'move', x: Math.round(p.x + ((m[2] - p.x) / d) * step), y: Math.round(p.y + ((m[3] - p.y) / d) * step) });
      await sleep(140);
      continue;
    }
    if (d < 2.8) {
      // stay at arm's length: inside our reach (<=4), outside its (melee + 0.5)
      const step = Math.min(1.6, 3.6 - d);
      A.send({ t: 'move', x: Math.round(p.x - ((m[2] - p.x) / d) * step), y: Math.round(p.y - ((m[3] - p.y) / d) * step) });
      await sleep(120);
      continue;
    }
    const before = st.hp;
    A.send({ t: 'attack', id });
    let r = null;
    try { r = await A.waitNew(x => x.t === 'combat' && x.id === id, 900); } catch (e) {}
    if (!r) { await sleep(120); continue; }
    if (r.err) { await sleep(60); continue; }
    if (r.killed) { st.hp = 0; return { killed: true, rolls: st.rolls, msg: r, before }; }
    const delta = before - r.hp;
    if (delta > 0) st.rolls.push(delta);
    st.hp = r.hp;
    await sleep(40);
  }
  return { killed: false, rolls: st.rolls, msg: null };
}

async function liveSection() {
  section('LIVE — a real server on an ephemeral port, driven by real clients');

  const port = await freePort();
  if (port === 8090) { ok(false, 'refusing to run on the live server port 8090'); return; }
  const db = path.join(__dirname, 'data', 'test-combat.db');
  wipe(db);
  const log = [];
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(port), STRATUM_DB: db, STRATUM_RESPAWN_SCALE: '0.02'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => log.push(String(d)));
  srv.stderr.on('data', d => log.push('[ERR] ' + String(d)));

  let A = null, B = null;
  try {
    await waitReady(port);
    ok(port !== 8090, 'the test server is listening on an ephemeral port :' + port);
    ok(fs.existsSync(db), 'the test server made its own database under data/', path.basename(db));

    const KEY_A = 'combat-key-AAAA-0001', KEY_B = 'combat-key-BBBB-0002';
    A = new Client('A'); B = new Client('B');
    await A.connect(port); await B.connect(port);
    A.send({ t: 'hello', key: KEY_A, name: 'HUNTER' });
    const wa = await A.waitFor(m => m.t === 'welcome', 10000);
    B.send({ t: 'hello', key: KEY_B, name: 'BYSTANDER' });
    const wb = await B.waitFor(m => m.t === 'welcome', 10000);
    let map = wa.map;
    A.map = map; B.map = map;
    ok(wa.world.w === 1024 && wa.world.h === 1024 && wa.maps.length === 3, 'a 1024x1024 world with 3 maps', wa.world);

    // Everything below is click-to-strike Frontier combat (wind-ups, aggro, leash, real
    // danger) — the cozy pivot made the spawn map (0) Sanctuary, where creatures use
    // ambient combat instead and 'attack' is refused. Move the attacker onto the one
    // Frontier map (1) before picking a target; the bystander stays behind on Sanctuary
    // ground, which is fine — it never fights either way.
    A.send({ t: 'travel', map: 1 });
    const arrA = await A.waitNew(x => x.t === 'arrived' && x.map === 1, 5000);
    ok(arrA && arrA.map === 1, 'A travelled to the Frontier map for combat testing', arrA && arrA.map);
    map = (arrA && arrA.map) || 1;
    A.map = map;

    // ---- pick a target by the world's own generator ----------------------
    const p0 = await A.posReady(8000);
    const homes = T.homesNear(map, Math.round(p0.x), Math.round(p0.y), 3);
    ok(homes.length >= 8, homes.length + ' monster homes generated around the spawn');
    // Prefer a tank whose den is not inside a pack hunter's call radius — map 1 (the
    // Frontier target for this section) has a pack archetype (CINDER_HOUND) that was
    // absent from the old default test map, and a duel fought inside its call radius
    // gets interrupted by allies again and again, which is its own (working-as-designed)
    // behaviour but not what THIS section means to exercise.
    const packHomes = homes.filter(h => h.sp.role === 'pack');
    const farFromPacks = h => packHomes.every(pk => Math.hypot(h.x - pk.x, h.y - pk.y) > ((pk.sp.pack && pk.sp.pack.callRadius) || 20) + 10);
    const tanks = homes.map(h => Object.assign({ d: Math.hypot(h.x - p0.x, h.y - p0.y) }, h))
      .filter(h => h.sp.role === 'tank')
      .sort((a, b) => a.d - b.d);
    const tankHome = tanks.find(farFromPacks) || tanks[0] || null;
    const swarmHome = homes.map(h => Object.assign({ d: Math.hypot(h.x - p0.x, h.y - p0.y) }, h))
      .filter(h => h.sp.role === 'swarm' && h.sp.speed >= 2.4 && h.d < 95 &&
        (!tankHome || Math.hypot(h.x - tankHome.x, h.y - tankHome.y) > 25))
      .sort((a, b) => a.d - b.d)[0] || null;
    ok(!!tankHome, 'chose a resident tank home at ' + (tankHome && Math.round(tankHome.x) + ',' + Math.round(tankHome.y)) +
      ' (' + (tankHome && tankHome.sp.kind) + ', ' + (tankHome && Math.round(tankHome.d)) + ' tiles away)');
    ok(!!swarmHome, 'chose a fast swarmling home at ' + (swarmHome && Math.round(swarmHome.x) + ',' + Math.round(swarmHome.y)) +
      ' (' + (swarmHome && swarmHome.sp.kind) + ', ' + (swarmHome && Math.round(swarmHome.d)) + ' tiles away)');
    if (!tankHome || !swarmHome) return;

    const residentOf = (home, maxDist) => {
      let best = null, bd = Infinity;
      for (const e of A.monsters()) {
        if (e[1] !== home.kind) continue;
        if (e[2] === undefined) continue;
        const d = Math.hypot(e[2] - home.x, e[3] - home.y);
        if (d < bd) { bd = d; best = e; }
      }
      return (best && bd <= (maxDist || 10)) ? { entry: best, distHome: bd } : null;
    };

    // ---- OUT OF RANGE: it should not care about us ------------------------
    await A.approach(tankHome.x, tankHome.y, tankHome.sp.aggro + 14, 60000);
    await sleep(700);
    let res = residentOf(tankHome);
    ok(!!res, 'found the resident ' + tankHome.sp.kind + ' near its home',
      res ? { id: res.entry[0], d: +res.distHome.toFixed(1) } : null);
    if (!res) return;
    const tankId = res.entry[0];
    const pOut = A.pos();
    const outDist = Math.hypot(res.entry[2] - pOut.x, res.entry[3] - pOut.y);
    let idleModes = [];
    for (let i = 0; i < 8; i++) { const e = A.monById(tankId); if (e) idleModes.push(e[6]); await sleep(150); }
    ok(idleModes.length > 0 && idleModes.every(m => m !== MODE.CHASE),
      'a monster ' + Math.round(outDist) + ' tiles away (outside its ' + tankHome.sp.aggro + ' aggro) never once chases',
      idleModes.slice(0, 6));

    // ---- AGGRO: walk into its notice and let it come to us ---------------
    const dTarget = A.monById(tankId) ? A.monById(tankId) : res.entry;
    await A.approach(dTarget[2], dTarget[3], Math.max(3.4, tankHome.sp.aggro - 1), 30000);
    const pIn = A.pos();
    const cur = A.monById(tankId) || res.entry;
    const dAtEntry = Math.hypot(cur[2] - pIn.x, cur[3] - pIn.y);
    let sawChase = false, minD = dAtEntry;
    const tAggro = Date.now();
    while (Date.now() - tAggro < 9000) {
      const e = A.monById(tankId);
      const p = A.pos();
      if (e && p) {
        if (e[6] === MODE.CHASE) sawChase = true;
        const d = Math.hypot(e[2] - p.x, e[3] - p.y);
        if (sawChase && d < minD) minD = d;
      }
      await sleep(120);                       // the player holds still: this is the AI moving
    }
    ok(sawChase, 'the monster AGGROS when the player comes near (mode chases)');
    ok(minD <= dAtEntry - 1.5, 'the aggroed monster closes on the player: ' + dAtEntry.toFixed(1) + ' -> ' + minD.toFixed(1) + ' tiles',
      { from: +dAtEntry.toFixed(1), to: +minD.toFixed(1) });

    // ---- KILL CYCLES: damage variance, crits, loot, XP, respawn ----------
    const st = { hp: res.entry[5], rolls: [] };
    let firstKill = null, killCount = 0, lootOk = true, lootChecked = 0, lootDetail = [], respawnTimes = [], respawnHomeOk = true;
    let invBefore = A.inv();
    for (let cycle = 0; cycle < 4 && st.rolls.length < 30; cycle++) {
      const m0 = A.monById(tankId);
      if (m0) st.hp = m0[5];                  // full HP on (re)spawn
      const t0 = Date.now();
      const deathsBefore = A.deaths;          // Frontier map 1 has neighbours that can
      const out1 = await duel(A, tankId, st, 45000);
      if (!out1.killed) { note('duel ' + (cycle + 1) + ' ran out of time after ' + ((Date.now() - t0) / 1000).toFixed(0) + 's'); break; }
      killCount++;
      if (!firstKill) firstKill = out1.msg;
      const inv = out1.msg.inv;
      // A death mid-duel (another nearby Frontier creature landing a blow) halves raw
      // resources and resets the baseline — a legitimate inventory drop, not a sign the
      // kill itself granted no loot, so an inv-delta comparison across one is inconclusive.
      const diedMidDuel = A.deaths !== deathsBefore;
      if (inv && invBefore && !diedMidDuel) {
        const gained = Object.keys(inv).filter(k => inv[k] > (invBefore[k] || 0));
        const legal = gained.length > 0 && gained.every(k => tankHome.sp.lootTable.some(e => e.item === k));
        if (!legal) lootOk = false;
        lootChecked++;
        lootDetail.push(gained.map(k => '+' + (inv[k] - invBefore[k]) + ' ' + k).join(' '));
      } else if (diedMidDuel) {
        lootDetail.push('(died mid-duel — inv baseline reset, skipped)');
      }
      invBefore = inv;

      // the corpse must come back AT ITS OWN HOME, on a tier-scaled clock
      const tKill = Date.now();
      let spawnMsg = null;
      try { spawnMsg = await A.waitNew(x => x.t === 'mon' && x.id === tankId && x.spawn, 25000); } catch (e) {}
      if (!spawnMsg) { ok(false, 'the killed monster respawned (timed out)'); break; }
      respawnTimes.push(Date.now() - tKill);
      const home = nearestHome(nearestHomes(map, spawnMsg.x, spawnMsg.y), spawnMsg.x, spawnMsg.y);
      const atHome = home && Math.abs(home.x - spawnMsg.x) < 0.6 && Math.abs(home.y - spawnMsg.y) < 0.6 && home.kind === tankHome.kind;
      if (!atHome) respawnHomeOk = false;
      ok(atHome, 'respawn #' + killCount + ': ' + tankHome.sp.kind + ' came back at its own generated home ' +
        Math.round(spawnMsg.x) + ',' + Math.round(spawnMsg.y), home && { hx: home.x, hy: home.y, kind: home.kind });
      const mAfter = A.monById(tankId);
      if (mAfter) st.hp = mAfter[5];
    }

    ok(killCount >= 1, 'repeated attacks killed the creature ' + killCount + ' time(s)');
    ok(st.rolls.length >= 8, 'collected ' + st.rolls.length + ' damage rolls off the wire');
    ok(!!firstKill, 'the server reported the kill on the wire', firstKill && { name: firstKill.name, loot: firstKill.loot });
    ok(lootChecked > 0, 'at least one kill was clean enough to check its loot delta (' + lootChecked + '/' + killCount + ')', lootDetail);
    ok(lootOk, 'loot was granted to the killer on death', lootDetail);
    ok(respawnTimes.length > 0 && respawnTimes.every(t => t >= 500 && t <= 20000),
      'the respawn clock fired in observable seconds with STRATUM_RESPAWN_SCALE=0.02: ' + respawnTimes.map(t => (t / 1000).toFixed(1) + 's').join(', '),
      respawnTimes);
    ok(respawnHomeOk, 'every respawn happened at the creature\'s home, not where it died');

    // ---- variance and crits over many rolls ------------------------------
    const distinct = new Set(st.rolls).size;
    const med = median(st.rolls);
    const crits = st.rolls.filter(v => v >= med * 1.4).length;
    ok(distinct >= 2, 'damage VARIES across ' + st.rolls.length + ' live blows (' + distinct + ' distinct: ' +
      [...new Set(st.rolls)].sort((a, b) => a - b).join(',') + ')', distinct);
    ok(crits >= 1, 'CRITS occur over many rolls (' + crits + ' blow(s) >= 1.4x the median ' + med + ')', st.rolls);
    ok(A.sawWindup, 'the server ships the attack wind-up phase — hits are telegraphed and dodgeable');

    // ---- XP and level, and that they went to the KILLER only -------------
    const st1 = await statsGet(port);
    const tagA = T.keyTag(KEY_A), tagB = T.keyTag(KEY_B);
    const hA = (st1.volatile.hunters || []).find(h => h.k === tagA);
    const hB = (st1.volatile.hunters || []).find(h => h.k === tagB);
    ok(!!hA && hA.xp > 0, 'the killer earned XP (' + (hA && hA.xp) + 'xp)', hA);
    ok(!hB || hB.xp === 0, 'the bystander earned none — XP goes to the killer', hB);
    ok(!!hA && hA.level >= 2, 'the killer\'s XP bought a LEVEL (level ' + (hA && hA.level) + ' from ' + killCount + ' kill(s))', hA && hA.level);
    ok(!!hA && hA.maxHp === T.maxHpForLevel(hA.level) && hA.atk === T.attackForLevel(hA.level),
      'max HP and attack are derived from the level (' + (hA && hA.maxHp) + 'hp / ' + (hA && hA.atk) + 'atk at L' + (hA && hA.level) + ')', hA);

    // ---- LEASH: drag a fast one out and watch it walk home ---------------
    const fastSp = swarmHome.sp;
    await A.approach(swarmHome.x, swarmHome.y, fastSp.aggro - 1, 60000);
    await sleep(500);
    let resident = residentOf(swarmHome, 12);
    ok(!!resident, 'found the resident ' + fastSp.kind + ' at its home', resident && resident.entry[0]);
    if (resident) {
      const fastId = resident.entry[0];
      const home = { x: swarmHome.x, y: swarmHome.y };
      const gap = Math.max(3.2, Math.min(6, fastSp.aggro * 0.7));
      let sawReturn = false, maxStray = 0, minStrayAfter = Infinity, peakAt = 0, chasedTicks = 0;
      const tK = Date.now();
      // retreat at roughly the creature's own pace so it keeps following us away from home
      while (Date.now() - tK < 30000) {
        const e = A.monById(fastId);
        const p = A.pos();
        if (e && p) {
          if (e[6] === MODE.CHASE) chasedTicks++;
          const dHome = Math.hypot(e[2] - home.x, e[3] - home.y);
          if (dHome > maxStray) { maxStray = dHome; peakAt = Date.now(); }
          if (sawReturn && dHome < minStrayAfter) minStrayAfter = dHome;
          if (e[6] === MODE.RETURN) sawReturn = true;
          // pick the retreat step that keeps it reachable and drags it furthest from home
          let bestPt = null, bestScore = -1e9;
          for (let i = 0; i < 16; i++) {
            const a = i * Math.PI / 8;
            const qx = e[2] + Math.cos(a) * gap, qy = e[3] + Math.sin(a) * gap;
            if (qx < 4 || qy < 4 || qx > T.W - 4 || qy > T.H - 4) continue;
            let dry = 0;
            for (let t = 1; t <= 4; t++) {
              const sx = e[2] + (qx - e[2]) * t / 4, sy = e[3] + (qy - e[3]) * t / 4;
              const b = T.baseTypeFor(map, Math.round(sx), Math.round(sy));
              if (b !== T.ID.WATER && b !== T.ID.VOID) dry++;
            }
            const score = dry * 20 + Math.hypot(qx - home.x, qy - home.y);
            if (score > bestScore) { bestScore = score; bestPt = { x: qx, y: qy }; }
          }
          if (bestPt) A.send({ t: 'move', x: Math.round(bestPt.x), y: Math.round(bestPt.y) });
        }
        await sleep(180);
        if (sawReturn && Date.now() - peakAt > 1200) break;
      }
      ok(maxStray > 8, 'the ' + fastSp.kind + ' was dragged ' + maxStray.toFixed(1) + ' tiles from its home (' + chasedTicks + ' chasing ticks)',
        { maxStray: +maxStray.toFixed(1) });
      ok(sawReturn, 'past its leash it gave up the chase and turned for home (mode=return)');

      // now get out of its aggro so it can settle, then watch it arrive
      await A.approach(home.x + (A.pos().x > home.x ? 30 : -30), home.y, 3, 20000);
      let backHome = Infinity;
      const tR = Date.now();
      while (Date.now() - tR < 30000) {
        const e = A.monById(fastId);
        if (e) {
          const d = Math.hypot(e[2] - home.x, e[3] - home.y);
          if (d < backHome) backHome = d;
          if (d <= 3.5) break;
        }
        await sleep(200);
      }
      ok(backHome <= 3.5, 'it walked home and settled within ' + (backHome === Infinity ? '??' : backHome.toFixed(1)) + ' tiles of its home',
        { backHome: backHome === Infinity ? null : +backHome.toFixed(1), leash: fastSp.leash });
    }

    // ---- the terrain rule, over every monster position the server ever sent
    const checks = A.tileChecks + B.tileChecks;
    const viol = A.waterViolations.concat(B.waterViolations);
    ok(checks > 500, checks + ' monster positions sampled off the wire', checks);
    ok(viol.length === 0, 'no monster ever stood in water, in the void or off the map', viol.slice(0, 4));

    const st2 = await statsGet(port);
    ok(st2.volatile.monstersKnown > 0 && st2.volatile.kills >= 1,
      'the volatile layer reports combat: ' + st2.volatile.kills + ' kills, forms ' + JSON.stringify(st2.volatile.forms));

  } finally {
    try { if (A) A.close(); } catch (e) {}
    try { if (B) B.close(); } catch (e) {}
    srv.kill();
    await sleep(300);
    if (fail > 0) {
      console.log('\n--- server log (last 30 lines) ---');
      console.log(log.join('').split('\n').slice(-30).join('\n'));
      console.log('--- end server log ---');
    }
  }
}

(async function main() {
  console.log('\nSTRATUM combat test — species, aggro, damage, death, loot, levelling\n');
  simSection();
  // STRATUM_COMBAT_SIM_ONLY=1 runs the in-process half alone (a fast inner loop while
  // working on the AI); the real server is what the contract asks for.
  if (process.env.STRATUM_COMBAT_SIM_ONLY === '1') console.log('\n(sim only — live server section skipped)');
  else await liveSection();
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('\nTEST HARNESS ERROR:', e.stack || e.message, '\n');
  process.exit(2);
});
