'use strict';
/* test-vanity.js — pure unit tests for STRATUM-priced vanity accessories
 * (src/customization.js additions). No server, no sockets. */
const CU = require('./src/customization.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// ---- pricing ----
check('vanityPrice-gilded', CU.vanityPrice('gilded-band') === 100);
check('vanityPrice-ember', CU.vanityPrice('ember-cloak') === 250);
check('vanityPrice-starlight', CU.vanityPrice('starlight-scarf') === 500);
check('vanityPrice-free-is-zero', CU.vanityPrice('plain-cap') === 0);
check('vanityPrice-gated-is-zero', CU.vanityPrice('slayers-hood') === 0);
check('vanityPrice-unknown-is-zero', CU.vanityPrice('nope') === 0 && CU.vanityPrice(null) === 0);
check('isVanity', CU.isVanity('ember-cloak') === true && CU.isVanity('plain-cap') === false && CU.isVanity('xx') === false);

// ---- purchase validation ----
check('buy-ok', JSON.stringify(CU.validateVanityBuy('gilded-band', 100, [])) === JSON.stringify({ ok: true, price: 100, error: null }));
check('buy-not-for-sale', CU.validateVanityBuy('slayers-hood', 9999, []).error === 'not for sale');
check('buy-unknown', CU.validateVanityBuy('nope', 9999, []).error === 'not for sale');
check('buy-already-owned-array', CU.validateVanityBuy('gilded-band', 500, ['gilded-band']).error === 'already owned');
check('buy-already-owned-set', CU.validateVanityBuy('gilded-band', 500, new Set(['gilded-band'])).error === 'already owned');
check('buy-cannot-afford', CU.validateVanityBuy('ember-cloak', 249, []).error === 'cannot afford');
check('buy-exact-afford', CU.validateVanityBuy('ember-cloak', 250, []).ok === true);
check('buy-garbage-pending', CU.validateVanityBuy('gilded-band', 'lots', []).error === 'cannot afford');
check('buy-never-throws', (function () {
  try { CU.validateVanityBuy(null, null, null); CU.validateVanityBuy('gilded-band', NaN, {}); return true; }
  catch (e) { return false; }
})());

// ---- validateLook with vanity ownership ----
check('look-vanity-stripped-when-unowned',
  CU.validateLook({ paletteId: 'moss', hat: 'gilded-band' }, [], []).hat === null);
check('look-vanity-kept-when-owned',
  CU.validateLook({ paletteId: 'moss', hat: 'gilded-band' }, [], ['gilded-band']).hat === 'gilded-band');
check('look-vanity-kept-with-set',
  CU.validateLook({ paletteId: 'moss', cloak: 'ember-cloak' }, [], new Set(['ember-cloak'])).cloak === 'ember-cloak');
check('look-achievement-path-unchanged',
  CU.validateLook({ paletteId: 'moss', hat: 'slayers-hood' }, ['slayer']).hat === 'slayers-hood');
check('look-achievement-still-gated',
  CU.validateLook({ paletteId: 'moss', hat: 'slayers-hood' }, []).hat === null);
check('look-vanity-not-unlocked-by-achievement',
  CU.validateLook({ paletteId: 'moss', hat: 'gilded-band' }, ['slayer', 'ascendant']).hat === null);
check('look-backward-compat-two-arg',
  CU.validateLook({ paletteId: 'clay', hat: null }, []).paletteId === 'clay');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
