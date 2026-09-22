'use strict';
/**
 * harvesting.js — cozy harvesting helper for Stratum.
 *
 * Documents existing Stratum harvestables (generated, not hand-placed):
 *
 * Resources (src/economy.js NODE_YIELDS / public/terrain.js NODE_KINDS):
 *   - TREE    (id 1) → wood    2/harvest, hp 3, respawn 45s
 *   - ORE     (id 2) → ore     2/harvest, hp 4, respawn 90s
 *   - HERB    (id 3) → herb    1/harvest, hp 1, respawn 30s
 *   - CRYSTAL (id 4) → crystal 1/harvest, hp 2, respawn 150s
 *
 * Monsters (public/terrain.js SPECIES, 3 maps × 4-5 species):
 *   Map 0 THE FIRST ACRE: MOSS_HOPPER, THICKET_MAW, STONE_SKITTER, BOULDERBACK, ACRE_RAT
 *   Map 1 ASHEN HOLLOW:   CINDER_HOUND, SLAG_WRETCH, ASH_SPITTER, EMBER_SWARMLING
 *   Map 2 SUNKEN SHELF:   BRINE_LURKER, SHELL_BRUTE, SALT_SPITTER, TIDE_SWARMLING
 *   Each species has tier/role/HP/atk/loot — see terrain.js SPECIES table.
 *
 * This helper does not generate world content; it just filters/sorts any
 * harvestable-like array [{name, position:[x,y]}] by Euclidean distance.
 */

// Example harvestables used for docs/tests — real world nodes come from world.js/terrain.js.
const EXAMPLE_RESOURCES = [
  { name: 'Iron Ore', position: [10, 20], kind: 'ORE', resource: 'ore' },
  { name: 'Wood', position: [30, 40], kind: 'TREE', resource: 'wood' },
];

const EXAMPLE_MONSTERS = [
  { name: 'Goblin', position: [5, 15], kind: 'ACRE_RAT' },
];

function _dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * List harvestables near a player, sorted by distance.
 * @param {number[]} playerPos - [x,y]
 * @param {Array<{name:string, position:[number,number]}>} items - harvestables
 * @param {number} maxDistance - inclusive radius (tiles)
 * @returns {Array} items within radius, each with added _distance, sorted nearest-first
 */
function listNearbyHarvestables(playerPos, items, maxDistance) {
  if (!Array.isArray(playerPos) || playerPos.length !== 2) return [];
  if (!Array.isArray(items)) items = [...EXAMPLE_RESOURCES, ...EXAMPLE_MONSTERS];
  if (typeof maxDistance !== 'number' || maxDistance < 0) return [];
  const out = [];
  for (const it of items) {
    if (!it || !Array.isArray(it.position) || it.position.length !== 2) continue;
    const d = _dist(playerPos, it.position);
    if (d <= maxDistance) out.push({ ...it, _distance: Math.round(d * 10) / 10 });
  }
  out.sort((a, b) => a._distance - b._distance);
  return out;
}

// Backward-compat for the minimal stub: getNearbyHarvestables(distance)
// interprets distance from origin [0,0] — kept so the local-model stub keeps passing.
function getNearbyHarvestables(distance) {
  return listNearbyHarvestables([0, 0], [...EXAMPLE_RESOURCES, ...EXAMPLE_MONSTERS], distance);
}

module.exports = {
  EXAMPLE_RESOURCES,
  EXAMPLE_MONSTERS,
  listNearbyHarvestables,
  getNearbyHarvestables,
};
