/* test-trade.js — assertions for src/trade.js. Prints PASS/FAIL per case, exits non-zero on any failure. */
'use strict';
var Tr = require('./src/trade.js');

var failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS ' + name);
  else { console.log('FAIL ' + name); failures++; }
}
function snap(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------- 1. validOffer
var gift = Tr.validOffer('wood', 3, undefined, undefined);
check('validOffer-gift-ok', gift.ok === true && gift.wantItem === null && gift.wantQty === 0);
var gift2 = Tr.validOffer('wood', 3, '', 0);
check('validOffer-empty-want-item-is-gift', gift2.ok === true && gift2.wantItem === null);
var swap = Tr.validOffer('wood', 3, 'ore', 2);
check('validOffer-two-sided-ok', swap.ok === true && swap.wantItem === 'ore' && swap.wantQty === 2);
check('validOffer-rejects-empty-give-item', Tr.validOffer('', 3, null, null).ok === false);
check('validOffer-rejects-numeric-give-item', Tr.validOffer(5, 3, null, null).ok === false);
check('validOffer-rejects-zero-give-qty', Tr.validOffer('wood', 0, null, null).ok === false);
check('validOffer-rejects-negative-give-qty', Tr.validOffer('wood', -3, null, null).ok === false);
check('validOffer-rejects-fractional-give-qty', Tr.validOffer('wood', 1.5, null, null).ok === false);
// a NAMED want item with an invalid quantity (0, negative, fractional) is refused
// outright rather than silently downgraded to a gift — magically ignoring a want the
// client explicitly specified would be more surprising than just rejecting it. Omitting
// wantItem entirely (tested above) is the only way to make a gift.
var zeroWant = Tr.validOffer('wood', 3, 'ore', 0);
check('validOffer-rejects-named-want-item-with-zero-qty', zeroWant.ok === false);
check('validOffer-rejects-want-item-same-as-give-item', Tr.validOffer('wood', 3, 'wood', 2).ok === false);
check('validOffer-rejects-fractional-want-qty', Tr.validOffer('wood', 3, 'ore', 1.5).ok === false);
check('validOffer-rejects-negative-want-qty', Tr.validOffer('wood', 3, 'ore', -1).ok === false);

// ---------------------------------------------------------------- 2. canEscrowGive / escrowGive
var invA = { wood: 6, ore: 4, herb: 2, crystal: 1 };
var invABefore = snap(invA);
check('canEscrowGive-true-when-affordable', Tr.canEscrowGive(invA, 'wood', 6) === true);
check('canEscrowGive-false-when-short', Tr.canEscrowGive(invA, 'wood', 7) === false);
check('canEscrowGive-false-for-bad-item', Tr.canEscrowGive(invA, '', 1) === false);

var escrowed = Tr.escrowGive(invA, 'wood', 4);
check('escrowGive-removes-exact-amount', escrowed && escrowed.wood === 2);
check('escrowGive-leaves-other-keys-untouched', escrowed && escrowed.ore === 4 && escrowed.herb === 2 && escrowed.crystal === 1);
check('escrowGive-input-untouched', snap(invA) === invABefore);
check('escrowGive-returns-fresh-object', escrowed !== invA);
check('escrowGive-null-when-unaffordable', Tr.escrowGive(invA, 'wood', 100) === null);
check('escrowGive-null-for-bad-qty', Tr.escrowGive(invA, 'wood', -1) === null);

// ---------------------------------------------------------------- 3. expired / describe
var now = 1000000;
var freshOffer = { createdAt: now, ttlMs: Tr.DEFAULT_TTL_MS };
check('expired-false-when-fresh', Tr.expired(freshOffer, now) === false);
check('expired-false-just-under-ttl', Tr.expired(freshOffer, now + Tr.DEFAULT_TTL_MS) === false);
check('expired-true-just-over-ttl', Tr.expired(freshOffer, now + Tr.DEFAULT_TTL_MS + 1) === true);
check('expired-true-for-null', Tr.expired(null, now) === true);
check('expired-true-for-malformed', Tr.expired({ createdAt: 'nope' }, now) === true);
check('DEFAULT_TTL_MS-is-7-days', Tr.DEFAULT_TTL_MS === 7 * 24 * 60 * 60 * 1000);

check('describe-gift', Tr.describe({ giveItem: 'wood', giveQty: 3 }) === '3 wood (gift)');
check('describe-swap', Tr.describe({ giveItem: 'wood', giveQty: 3, wantItem: 'ore', wantQty: 2 }) === '3 wood for 2 ore');
check('describe-malformed', Tr.describe(null) === 'an empty offer');
check('describe-malformed-no-giveItem', Tr.describe({}) === 'an empty offer');

// ---------------------------------------------------------------- 4. canAccept / accept
var giftOffer = { from: 'A', to: 'B', giveItem: 'wood', giveQty: 5, wantItem: null, wantQty: 0, createdAt: 0, ttlMs: Tr.DEFAULT_TTL_MS };
var poorB = { ore: 0 };
check('canAccept-gift-always-true', Tr.canAccept(giftOffer, poorB) === true);

var acceptedGift = Tr.accept(giftOffer, poorB);
check('accept-gift-ok', acceptedGift.ok === true);
check('accept-gift-credits-give-item', acceptedGift.accepterInv.wood === 5);
check('accept-gift-paid-is-zero', acceptedGift.paid === 0);
check('accept-gift-input-untouched', poorB.ore === 0 && poorB.wood === undefined);
check('accept-gift-returns-fresh-object', acceptedGift.accepterInv !== poorB);

var swapOffer = { from: 'A', to: 'B', giveItem: 'wood', giveQty: 5, wantItem: 'ore', wantQty: 3, createdAt: 0, ttlMs: Tr.DEFAULT_TTL_MS };
var richB = { ore: 10, wood: 0 };
check('canAccept-swap-true-when-affordable', Tr.canAccept(swapOffer, richB) === true);
var poorB2 = { ore: 1, wood: 0 };
check('canAccept-swap-false-when-short', Tr.canAccept(swapOffer, poorB2) === false);

var acceptedSwap = Tr.accept(swapOffer, richB);
check('accept-swap-ok', acceptedSwap.ok === true);
check('accept-swap-deducts-want-item', acceptedSwap.accepterInv.ore === 7);
check('accept-swap-credits-give-item', acceptedSwap.accepterInv.wood === 5);
check('accept-swap-paid-equals-wantQty', acceptedSwap.paid === 3);
check('accept-swap-input-untouched', richB.ore === 10 && richB.wood === 0);

var failedSwap = Tr.accept(swapOffer, poorB2);
check('accept-swap-refused-when-cannot-afford', failedSwap.ok === false && failedSwap.error === 'cannot afford');
check('accept-swap-refused-input-untouched', poorB2.ore === 1 && poorB2.wood === 0);
// the crucial atomicity property: a failed accept must not have taken anything OR given
// anything — a partial swap (payment taken but gift not received, or vice versa) would
// be exactly the "silently fail or double-spend" bug this whole system exists to prevent.
check('accept-swap-refused-no-partial-inv-returned', failedSwap.accepterInv === undefined);

check('accept-refused-for-null-offer', Tr.accept(null, richB).ok === false);
check('accept-refused-for-malformed-offer', Tr.accept({ giveItem: '', giveQty: 5 }, richB).ok === false);

// a want side of 0/absent is always treated as a gift by accept(), even if the field is
// present but zero — mirrors validOffer's normalisation
var zeroWantOffer = { giveItem: 'wood', giveQty: 2, wantItem: 'ore', wantQty: 0 };
var acceptedZeroWant = Tr.accept(zeroWantOffer, { ore: 0 });
check('accept-zero-want-qty-is-gift', acceptedZeroWant.ok === true && acceptedZeroWant.paid === 0);

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
process.exit(failures === 0 ? 0 : 1);
