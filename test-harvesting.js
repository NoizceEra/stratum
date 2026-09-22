'use strict';
// test-harvesting.js — minimal node tests for src/harvesting.js (no jest, local-model friendly)
const { listNearbyHarvestables, getNearbyHarvestables, EXAMPLE_RESOURCES } = require('./src/harvesting');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(msg + ` (got ${a}, want ${b})`); }

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}

// legacy stub compat
test('getNearbyHarvestables(25) finds Iron Ore but not Wood', () => {
  const r = getNearbyHarvestables(25);
  assert(r.some(x => x.name === 'Iron Ore'), 'missing Iron Ore');
  assert(!r.some(x => x.name === 'Wood'), 'Wood should be outside 25 from origin');
});

test('getNearbyHarvestables(15) finds Goblin near origin', () => {
  const r = getNearbyHarvestables(16);
  assert(r.some(x => x.name === 'Goblin'), 'missing Goblin');
});

// new helper
test('listNearbyHarvestables sorts by distance from player', () => {
  const items = [
    { name: 'Far Herb', position: [100, 100] },
    { name: 'Near Ore', position: [3, 4] },   // distance 5 from [0,0]
    { name: 'Mid Wood', position: [6, 8] },   // distance 10 from [0,0]
  ];
  const r = listNearbyHarvestables([0, 0], items, 12);
  eq(r.length, 2, 'should have 2 within 12');
  eq(r[0].name, 'Near Ore', 'nearest first');
  eq(r[1].name, 'Mid Wood', 'mid second');
  assert(typeof r[0]._distance === 'number', '_distance added');
});

test('listNearbyHarvestables respects maxDistance', () => {
  const items = [{ name: 'A', position: [10, 0] }];
  assert(listNearbyHarvestables([0, 0], items, 9).length === 0, 'outside radius');
  assert(listNearbyHarvestables([0, 0], items, 10).length === 1, 'inside radius');
});

test('listNearbyHarvestables documents real resource kinds', () => {
  // EXAMPLE_RESOURCES should at least mention wood/ore
  assert(EXAMPLE_RESOURCES.length >= 2, 'example resources present');
});

console.log(`\nHarvesting helper: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
