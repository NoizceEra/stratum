/* test-shops.js — assertions for src/shops.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var S = require('./src/shops.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function snap(v) { return JSON.stringify(v); }
function deep(a, b) { return snap(a) === snap(b); }

// ---------------------------------------------------------------- 1. validListing
check('validListing-happy-path', S.validListing('ore', 5, 'wood', 2).ok === true);
check('validListing-rejects-empty-item', S.validListing('', 5, 'wood', 2).ok === false);
check('validListing-rejects-numeric-item', S.validListing(3, 5, 'wood', 2).ok === false);
check('validListing-rejects-empty-priceItem', S.validListing('ore', 5, '', 2).ok === false);
check('validListing-rejects-same-item-as-price', S.validListing('ore', 5, 'ore', 2).ok === false);
check('validListing-rejects-zero-qty', S.validListing('ore', 0, 'wood', 2).ok === false);
check('validListing-rejects-negative-qty', S.validListing('ore', -5, 'wood', 2).ok === false);
check('validListing-rejects-fractional-qty', S.validListing('ore', 1.5, 'wood', 2).ok === false);
check('validListing-rejects-NaN-qty', S.validListing('ore', NaN, 'wood', 2).ok === false);
check('validListing-rejects-zero-priceQty', S.validListing('ore', 5, 'wood', 0).ok === false);
check('validListing-rejects-negative-priceQty', S.validListing('ore', 5, 'wood', -1).ok === false);
check('validListing-rejects-qty-over-max', S.validListing('ore', S.MAX_QTY + 1, 'wood', 2).ok === false);
check('validListing-accepts-qty-at-max', S.validListing('ore', S.MAX_QTY, 'wood', 2).ok === true);

// ---------------------------------------------------------------- 2. canEscrow / escrow
var inv = { wood: 6, ore: 4, herb: 2, crystal: 1 };
var invBefore = snap(inv);
check('canEscrow-true-when-affordable', S.canEscrow(inv, 'ore', 4) === true);
check('canEscrow-false-when-short', S.canEscrow(inv, 'ore', 5) === false);
check('canEscrow-false-for-unknown-key', S.canEscrow(inv, 'nonexistent', 1) === false);
check('canEscrow-false-for-bad-qty', S.canEscrow(inv, 'ore', 0) === false);

var afterEscrow = S.escrow(inv, 'ore', 4);
check('escrow-removes-exact-amount', afterEscrow && afterEscrow.ore === 0);
check('escrow-leaves-other-keys-untouched', afterEscrow && afterEscrow.wood === 6 && afterEscrow.herb === 2 && afterEscrow.crystal === 1);
check('escrow-input-untouched', snap(inv) === invBefore);
check('escrow-returns-fresh-object', afterEscrow !== inv);
check('escrow-null-when-unaffordable', S.escrow(inv, 'ore', 100) === null);
check('escrow-null-for-bad-item', S.escrow(inv, '', 1) === null);
check('escrow-null-for-negative-qty', S.escrow(inv, 'ore', -1) === null);

var partial = S.escrow(inv, 'ore', 1);
check('escrow-partial-leaves-remainder', partial && partial.ore === 3);

// ---------------------------------------------------------------- 3. costFor
check('costFor-multiplies', S.costFor(2, 5) === 10);
check('costFor-single-unit', S.costFor(2, 1) === 2);
check('costFor-zero-for-bad-priceQty', S.costFor(0, 5) === 0);
check('costFor-zero-for-bad-buyQty', S.costFor(2, 0) === 0);
check('costFor-zero-for-negative', S.costFor(2, -1) === 0);

// ---------------------------------------------------------------- 4. canBuy / buy
var listing = { seller: 'seller-key', item: 'ore', qty: 5, priceItem: 'wood', priceQty: 2 };
var buyerInv = { wood: 10, ore: 0 };
check('canBuy-true-when-affordable-and-in-stock', S.canBuy(listing, buyerInv, 2) === true);
check('canBuy-false-when-exceeds-stock', S.canBuy(listing, buyerInv, 6) === false);
check('canBuy-false-when-cannot-afford', S.canBuy(listing, { wood: 1 }, 2) === false);
check('canBuy-false-for-no-listing', S.canBuy(null, buyerInv, 1) === false);
check('canBuy-false-for-bad-qty', S.canBuy(listing, buyerInv, 0) === false);

var bought = S.buy(listing, buyerInv, 2);
check('buy-ok-true', bought.ok === true);
check('buy-deducts-correct-price', bought.buyerInv.wood === 6);
check('buy-credits-correct-item', bought.buyerInv.ore === 2);
check('buy-reports-correct-cost', bought.cost === 4);
check('buy-reports-remaining-stock', bought.remainingQty === 3);
check('buy-input-buyerInv-untouched', buyerInv.wood === 10 && buyerInv.ore === 0);
check('buy-returns-fresh-object', bought.buyerInv !== buyerInv);
check('buy-input-listing-untouched', listing.qty === 5);

// sell out entirely
var sellOut = S.buy(listing, { wood: 100 }, 5);
check('buy-can-take-entire-stock', sellOut.ok === true && sellOut.remainingQty === 0);

// over-buy is refused, not clamped
var overBuy = S.buy(listing, { wood: 100 }, 6);
check('buy-refuses-more-than-stock', overBuy.ok === false && overBuy.error === 'not enough stock');
check('buy-overbuy-untouched-listing', listing.qty === 5);

// cannot afford
var poorBuyer = { wood: 1 };
var cantAfford = S.buy(listing, poorBuyer, 2);
check('buy-refuses-when-cannot-afford', cantAfford.ok === false && cantAfford.error === 'cannot afford');
check('buy-cant-afford-buyer-untouched', poorBuyer.wood === 1);

// bad quantity
check('buy-refuses-zero-qty', S.buy(listing, buyerInv, 0).ok === false);
check('buy-refuses-negative-qty', S.buy(listing, buyerInv, -1).ok === false);
check('buy-refuses-fractional-qty', S.buy(listing, buyerInv, 1.5).ok === false);
check('buy-refuses-null-listing', S.buy(null, buyerInv, 1).ok === false);

// buying respects a separately-tracked remaining qty (the caller persists remainingQty
// and passes a listing object reflecting the CURRENT stock on each call — this proves
// two sequential partial buys stack correctly when the caller does that bookkeeping)
var stock = { seller: 's', item: 'herb', qty: 10, priceItem: 'crystal', priceQty: 1 };
var buyer2 = { crystal: 10 };
var first = S.buy(stock, buyer2, 4);
check('sequential-buy-1-ok', first.ok === true && first.remainingQty === 6);
var stockAfter1 = Object.assign({}, stock, { qty: first.remainingQty });
var second = S.buy(stockAfter1, first.buyerInv, 6);
check('sequential-buy-2-exhausts-stock', second.ok === true && second.remainingQty === 0);
check('sequential-buy-2-final-inv', second.buyerInv.herb === 10 && second.buyerInv.crystal === 0);

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
