/** test-geography.js — resource-geography checks for STRATUM worlds.
 *
 * Requires public/terrain.js in Node, scans nodesInChunk coverage in a
 * 40-tile disk around each map's spawn, and asserts:
 *   per map: >=3 TREE (id 1), >=2 HERB (id 3), >=2 ORE (id 2)
 *   onboarding: map 0 TREE>=1 within view radius 12 of spawn
 *   character: map 1 poorer in vegetation than map 0; map 2 scarcest land
 *   determinism: two identical scans give identical nodes
 *   validity: no node in water, void, or off-map
 * Exits non-zero on any failure.
 */
'use strict';
var T = require('./public/terrain.js');

var RADIUS = 40;
var VIEW = 12;
var NEED = { 1: 3, 3: 2, 2: 2 }; // TREE id1, HERB id3, ORE id2
var KIND_NAME = { 1: 'TREE', 2: 'ORE', 3: 'HERB', 4: 'CRYSTAL' };

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

/** All nodes within radius of (sx,sy) via nodesInChunk coverage. */
function scanAround(mapId, sx, sy, radius) {
  radius = radius == null ? RADIUS : radius;
  var out = [];
  var c0x = Math.floor((sx - radius) / T.CHUNK), c1x = Math.floor((sx + radius) / T.CHUNK);
  var c0y = Math.floor((sy - radius) / T.CHUNK), c1y = Math.floor((sy + radius) / T.CHUNK);
  for (var cy = c0y; cy <= c1y; cy++) {
    for (var cx = c0x; cx <= c1x; cx++) {
      if (cx < 0 || cy < 0 || cx * T.CHUNK >= T.W || cy * T.CHUNK >= T.H) continue;
      var list = T.nodesInChunk(mapId, cx, cy);
      for (var i = 0; i < list.length; i++) {
        var dx = list[i][0] - sx, dy = list[i][1] - sy;
        if (dx * dx + dy * dy <= radius * radius) out.push(list[i]);
      }
    }
  }
  out.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0] || a[2] - b[2]; });
  return out;
}

function landFrac(mapId) {
  var land = 0, n = 0;
  for (var i = 0; i < 20000; i++) {
    var b = T.baseTypeFor(mapId, (i * 37) % T.W, (i * 101) % T.H);
    n++;
    if (b !== T.ID.WATER && b !== T.ID.VOID) land++;
  }
  return land / n;
}

var counts = [];
for (var m = 0; m < 3; m++) {
  var s = T.spawnPoint(m);
  var nodes = scanAround(m, s.x, s.y);
  var c = { 1: 0, 2: 0, 3: 0, 4: 0 };
  var bad = 0;
  for (var i = 0; i < nodes.length; i++) {
    var nx = nodes[i][0], ny = nodes[i][1], id = nodes[i][2];
    c[id] = (c[id] || 0) + 1;
    var b = (nx < 0 || ny < 0 || nx >= T.W || ny >= T.H)
      ? -1 : T.baseTypeFor(m, nx, ny);
    if (b === -1 || b === T.ID.WATER || b === T.ID.VOID) {
      bad++;
      console.log('  invalid node map=' + m + ' at (' + nx + ',' + ny + ') id=' + id + ' base=' + b);
    }
    if (!KIND_NAME[id]) { bad++; console.log('  unknown kind id=' + id); }
  }
  counts.push(c);
  console.log('map ' + m + ' spawn (' + s.x + ',' + s.y + ') nodes in radius: ' +
    'TREE=' + c[1] + ' ORE=' + c[2] + ' HERB=' + c[3] + ' CRYSTAL=' + (c[4] || 0));
  check('map' + m + ' TREE>=3', c[1] >= NEED[1], 'found ' + c[1]);
  check('map' + m + ' HERB>=2', c[3] >= NEED[3], 'found ' + c[3]);
  check('map' + m + ' ORE>=2', c[2] >= NEED[2], 'found ' + c[2]);
  check('map' + m + ' all nodes valid (not water/void/off-map)', bad === 0, bad + ' bad');
  if (m === 0) {
    var near = scanAround(m, s.x, s.y, VIEW);
    var treesNear = 0;
    for (var ti = 0; ti < near.length; ti++) if (near[ti][2] === 1) treesNear++;
    console.log('map 0 trees within view r=' + VIEW + ': ' + treesNear);
    check('map0 TREE>=1 within view r' + VIEW, treesNear >= 1, 'found ' + treesNear);
  }

  // determinism: rescan must be identical
  var again = scanAround(m, s.x, s.y);
  var same = again.length === nodes.length &&
    again.every(function (nd, k) { return nd[0] === nodes[k][0] && nd[1] === nodes[k][1] && nd[2] === nodes[k][2]; });
  check('map' + m + ' deterministic', same, nodes.length + ' nodes rescanned');
}

// character: map 1 rock-poor in vegetation relative to map 0
var veg0 = counts[0][1] + counts[0][3], veg1 = counts[1][1] + counts[1][3];
check('character map1 veg < map0 veg', veg1 < veg0, veg1 + ' vs ' + veg0);
check('character map1 trees <= map0 trees', counts[1][1] <= counts[0][1],
  counts[1][1] + ' vs ' + counts[0][1]);

// character: map 2 land-scarce overall
var lf = [landFrac(0), landFrac(1), landFrac(2)];
console.log('landfrac map0=' + lf[0].toFixed(3) + ' map1=' + lf[1].toFixed(3) + ' map2=' + lf[2].toFixed(3));
check('character map2 scarcest land', lf[2] < lf[0] && lf[2] < lf[1],
  'map2=' + lf[2].toFixed(3));

// cozy pivot (ROADMAP_COZY.md, Phase 0): the tone flag exists and resolves correctly,
// including for an id nobody generated a map for.
check('map0 tone sanctuary', T.toneOf(0) === 'sanctuary');
check('map1 tone frontier', T.toneOf(1) === 'frontier');
check('map2 tone sanctuary', T.toneOf(2) === 'sanctuary');
check('unknown map defaults frontier, not MAP0 leakage', T.toneOf(99) === 'frontier');

console.log(failures === 0 ? 'ALL GEOGRAPHY CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
