/* test-ambient-combat.js — assertions for src/ambient-combat.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
var AC = require('./src/ambient-combat.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}

// ---------------------------------------------------------------- inRange
check('inRange-adjacent-true', AC.inRange({ x: 10, y: 10 }, { x: 11, y: 10 }, 3));
check('inRange-at-exact-boundary-true', AC.inRange({ x: 0, y: 0 }, { x: 3, y: 0 }, 3));
check('inRange-just-past-boundary-false', AC.inRange({ x: 0, y: 0 }, { x: 3.01, y: 0 }, 3) === false);
check('inRange-far-false', AC.inRange({ x: 0, y: 0 }, { x: 50, y: 50 }, 3) === false);
check('inRange-default-range-used-when-omitted', AC.inRange({ x: 0, y: 0 }, { x: 1, y: 0 }) === true);
check('inRange-malformed-a-false', AC.inRange(null, { x: 0, y: 0 }, 3) === false);
check('inRange-malformed-b-false', AC.inRange({ x: 0, y: 0 }, { x: NaN, y: 0 }, 3) === false);

// ---------------------------------------------------------------- tickReady
check('tickReady-never-ticked-true', AC.tickReady(undefined, 1000, 2500) === true);
check('tickReady-just-ticked-false', AC.tickReady(1000, 1500, 2500) === false);
check('tickReady-interval-elapsed-true', AC.tickReady(1000, 3500, 2500) === true);
check('tickReady-exactly-at-boundary-true', AC.tickReady(1000, 3500, 2500) === true);
check('tickReady-bad-now-false', AC.tickReady(1000, 'soon', 2500) === false);
check('tickReady-default-interval-used-when-omitted', AC.tickReady(0, AC.TUNE.tickMs + 1) === true);

// ---------------------------------------------------------------- resolveTick — damage
var p = { hp: 100, maxHp: 100 };
var c = { hp: 20, maxHp: 20 };
var r1 = AC.resolveTick(p, c);
check('resolveTick-creature-takes-fixed-damage', r1.creature.hp === 20 - AC.TUNE.playerDmgPerTick);
check('resolveTick-player-takes-fixed-damage', r1.player.hp === 100 - AC.TUNE.creatureDmgPerTick);
check('resolveTick-player-input-untouched', p.hp === 100);
check('resolveTick-creature-input-untouched', c.hp === 20);
check('resolveTick-not-dead-yet', r1.creatureDied === false);

// ---------------------------------------------------------------- resolveTick — kill
var weakC = { hp: 1, maxHp: 20 };
var r2 = AC.resolveTick(p, weakC);
check('resolveTick-creature-dies-at-zero-not-negative', r2.creature.hp === 0);
check('resolveTick-creatureDied-true', r2.creatureDied === true);
check('resolveTick-player-untouched-on-kill', r2.player.hp === 100);   // no retaliation from a dead creature

// ---------------------------------------------------------------- resolveTick — HP floor
var lowHp = { hp: 21, maxHp: 100 };   // floor at 20% of 100 = 20
var r3 = AC.resolveTick(lowHp, { hp: 20, maxHp: 20 });
check('resolveTick-respects-hp-floor', r3.player.hp === 20);
var atFloor = { hp: 20, maxHp: 100 };
var r4 = AC.resolveTick(atFloor, { hp: 20, maxHp: 20 });
check('resolveTick-never-drops-below-floor', r4.player.hp === 20);
var custom = { playerDmgPerTick: 4, creatureDmgPerTick: 50, hpFloorFrac: 0.5 };
var r5 = AC.resolveTick({ hp: 60, maxHp: 100 }, { hp: 20, maxHp: 20 }, custom);
check('resolveTick-custom-tune-respected', r5.player.hp === 50);   // floor = 50, would've gone to 10

// ---------------------------------------------------------------- resolveTick — malformed input never throws
var r6 = AC.resolveTick(null, null);
check('resolveTick-malformed-never-throws-player', r6.player.hp <= r6.player.maxHp);
check('resolveTick-malformed-never-throws-creature', r6.creature.hp >= 0);

// ---------------------------------------------------------------- dueTicks
var player = { x: 0, y: 0 };
var creatures = [
  { id: 'near-ready', x: 1, y: 0 },
  { id: 'near-cooling', x: 1, y: 1 },
  { id: 'far', x: 90, y: 90 }
];
var lastTicks = { 'near-cooling': 900 };
var due = AC.dueTicks(player, creatures, function (c) { return lastTicks[c.id]; }, 1000, { range: 3, tickMs: 2500 });
check('dueTicks-includes-near-never-ticked', due.some(function (c) { return c.id === 'near-ready'; }));
check('dueTicks-excludes-near-but-cooling', !due.some(function (c) { return c.id === 'near-cooling'; }));
check('dueTicks-excludes-far', !due.some(function (c) { return c.id === 'far'; }));
check('dueTicks-malformed-player-empty', AC.dueTicks(null, creatures, function () { return 0; }, 1000).length === 0);
check('dueTicks-malformed-creatures-empty', AC.dueTicks(player, null, function () { return 0; }, 1000).length === 0);

// ---------------------------------------------------------------- purity / hygiene
var source = require('fs').readFileSync('./src/ambient-combat.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random',
  source.indexOf('Math.random') === -1 && source.indexOf('Date.now') === -1);
check('source-has-no-require-or-io',
  source.indexOf('require(') === -1 && source.indexOf('XMLHttpRequest') === -1 &&
  source.indexOf('process.') === -1);
check('exports-are-frozen-tables', Object.isFrozen(AC.TUNE));

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
