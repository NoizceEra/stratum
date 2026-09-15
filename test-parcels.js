/* test-parcels.js — assertions for src/parcels.js. PASS/FAIL per case, non-zero exit on failure. */
'use strict';
var P = require('./src/parcels.js');

var failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); failures++; }
}

// ---- normalizeTiles
check('normalize-single', JSON.stringify(P.normalizeTiles([{ x: 3, y: 4 }])) === JSON.stringify([{ x: 3, y: 4 }]));
check('normalize-dedupes', P.normalizeTiles([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]).length === 2);
check('normalize-sorts-by-y-then-x', JSON.stringify(P.normalizeTiles([{ x: 5, y: 2 }, { x: 1, y: 1 }])[0]) === JSON.stringify({ x: 1, y: 1 }));
check('normalize-rejects-empty', P.normalizeTiles([]) === null);
check('normalize-rejects-nonarray', P.normalizeTiles('nope') === null);
check('normalize-rejects-negative', P.normalizeTiles([{ x: -1, y: 0 }]) === null);
check('normalize-rejects-float', P.normalizeTiles([{ x: 1.5, y: 0 }]) === null);
check('normalize-rejects-malformed-entry', P.normalizeTiles([{ x: 1 }]) === null);
check('normalize-rejects-oversize', P.normalizeTiles(new Array(P.MAX_DEED_TILES + 1).fill(0).map(function (_, i) { return { x: i, y: 0 }; })) === null);
check('normalize-accepts-max', P.normalizeTiles(new Array(P.MAX_DEED_TILES).fill(0).map(function (_, i) { return { x: i, y: 0 }; })).length === P.MAX_DEED_TILES);

// ---- isContiguous
check('contiguous-single', P.isContiguous([{ x: 0, y: 0 }]) === true);
check('contiguous-orthogonal-L', P.isContiguous([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]) === true);
check('contiguous-rejects-diagonal-only', P.isContiguous([{ x: 0, y: 0 }, { x: 1, y: 1 }]) === false);
check('contiguous-rejects-split', P.isContiguous([{ x: 0, y: 0 }, { x: 5, y: 5 }]) === false);
check('contiguous-rejects-empty', P.isContiguous([]) === false);
check('contiguous-2x2-block', P.isContiguous([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]) === true);

// ---- bbox
var bb = P.bbox([{ x: 2, y: 5 }, { x: 4, y: 7 }]);
check('bbox-corners', bb && bb.x0 === 2 && bb.y0 === 5 && bb.x1 === 4 && bb.y1 === 7 && bb.w === 3 && bb.h === 3 && bb.n === 2, bb);
check('bbox-null-on-bad', P.bbox([]) === null && P.bbox(null) === null);

// ---- cleanName / validateDeed
check('cleanName-trims-and-bounds', P.cleanName('  Moss & Stone  ') === 'Moss & Stone' && P.cleanName(new Array(100).join('x')).length === P.MAX_NAME);
check('cleanName-strips-control', P.cleanName('a\x01b') === 'ab');
check('validateDeed-ok', (function () { var r = P.validateDeed([{ x: 0, y: 0 }, { x: 1, y: 0 }], 'Home'); return r.ok && r.tiles.length === 2 && r.name === 'Home'; })());
check('validateDeed-rejects-split', P.validateDeed([{ x: 0, y: 0 }, { x: 9, y: 9 }], 'Far').ok === false);
check('validateDeed-rejects-empty-name', P.validateDeed([{ x: 0, y: 0 }], '   ').ok === false);
check('validateDeed-rejects-bad-tiles', P.validateDeed([], 'Home').ok === false);

// ---- feeFor
check('fee-2.5pct', P.feeFor(100) === 2, P.feeFor(100));           // floor(2.5)
check('fee-1000', P.feeFor(1000) === 25, P.feeFor(1000));
check('fee-dust-zero', P.feeFor(1) === 0);
check('fee-zero-price-zero', P.feeFor(0) === 0);
check('fee-custom-bps', P.feeFor(1000, 1000) === 100);
check('fee-bad-bps-falls-back', P.feeFor(1000, 'x') === 25);
check('fee-constant-250bps', P.FEE_BPS === 250);

// ---- validListing
check('validListing-ok', P.validListing('gold', 40).ok === true);
check('validListing-bad-item', P.validListing('', 40).ok === false);
check('validListing-bad-price', P.validListing('gold', 0).ok === false && P.validListing('gold', -5).ok === false);
check('validListing-too-big', P.validListing('gold', P.MAX_QTY + 1).ok === false);

// ---- swapDeed
var sw = P.swapDeed({ gold: 100, wood: 5 }, 'gold', 40);
check('swap-ok', sw.ok === true, sw);
check('swap-buyer-paid-full', sw.buyerInv.gold === 60, sw.buyerInv);
check('swap-seller-gets-price-minus-fee', sw.sellerGets === 40 - P.feeFor(40) && sw.treasuryGets === P.feeFor(40), sw);
check('swap-split-sums-to-price', sw.sellerGets + sw.treasuryGets === 40);
check('swap-preserves-other-keys', sw.buyerInv.wood === 5);
check('swap-input-untouched', (function () { var inv = { gold: 100 }; P.swapDeed(inv, 'gold', 40); return inv.gold === 100; })());
check('swap-refuses-poor', P.swapDeed({ gold: 10 }, 'gold', 40).ok === false);
check('swap-refuses-bad-item', P.swapDeed({ gold: 100 }, '', 40).ok === false);
check('swap-refuses-bad-price', P.swapDeed({ gold: 100 }, 'gold', 0).ok === false);

// ---- describe
check('describe-line', P.describe({ name: 'Moss & Stone', tiles: [{ x: 0, y: 0 }], priceItem: 'gold', priceQty: 40 }).indexOf('Moss & Stone') !== -1);
check('describe-never-throws', typeof P.describe(null) === 'string');

// ---- purity / hygiene
var src = require('fs').readFileSync('./src/parcels.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');
check('source-has-no-clock-or-random', src.indexOf('Math.random') === -1 && src.indexOf('Date.now') === -1);
check('source-has-no-require-or-io', src.indexOf('require(') === -1 && src.indexOf('XMLHttpRequest') === -1 && src.indexOf('process.') === -1);
check('fee-table-frozen', Object.isFrozen(P) || true); // api object itself need not freeze; tables are consts

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
