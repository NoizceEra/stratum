'use strict';
/**
 * test-payout.js — claim/convert fee math and wallet-link signatures.
 * No server, no network.
 */
const Payout = require('./src/payout.js');
const Proof = require('./src/wallet-proof.js');
const TC = require('./src/token-config.js');
const { Keypair } = require('@solana/web3.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}

check('claim-50-keeps-one', (function () {
  var q = Payout.quoteClaim(50, 250, 50);
  return q.ok && q.gross === 50 && q.fee === 1 && q.payout === 49 && q.fee + q.payout === q.gross;
})());
check('claim-below-floor', (function () {
  var q = Payout.quoteClaim(49, 250, 50);
  return !q.ok && q.error.indexOf('below minimum claim') === 0;
})());
check('claim-empty', Payout.quoteClaim(0, 250, 50).error === 'nothing pending');
check('claim-zero-fee', (function () {
  var q = Payout.quoteClaim(10, 0, 1);
  return q.ok && q.fee === 0 && q.payout === 10;
})());

check('convert-gold-to-strm', (function () {
  var q = Payout.quoteConvert('to-token', 400, { gold: 500, pending: 0 }, { feeBps: 250, goldPerStrm: 10, minStrm: 40 });
  return q.ok && q.spentGold === 400 && q.gross === 40 && q.fee === 1 && q.payout === 39;
})());
check('convert-all-gold-leaves-dust', (function () {
  var q = Payout.quoteConvert('to-token', undefined, { gold: 415, pending: 0 }, { feeBps: 250, goldPerStrm: 10, minStrm: 40 });
  return q.ok && q.spentGold === 410 && q.gross === 41 && q.fee === 1 && q.payout === 40;
})());
check('convert-below-min', (function () {
  var q = Payout.quoteConvert('to-token', 100, { gold: 100, pending: 0 }, { feeBps: 250, goldPerStrm: 10, minStrm: 40 });
  return !q.ok && q.error.indexOf('below minimum convert') === 0;
})());
check('convert-strm-to-gold', (function () {
  var q = Payout.quoteConvert('to-gold', 40, { gold: 0, pending: 80 }, { feeBps: 250, goldPerStrm: 10, minStrm: 40 });
  return q.ok && q.gross === 40 && q.fee === 1 && q.payout === 39 && q.goldOut === 390;
})());
check('convert-cannot-afford', Payout.quoteConvert('to-gold', 50, { gold: 0, pending: 40 }, {}).error === 'cannot afford');
check('convert-bad-dir', Payout.quoteConvert('sideways', 40, { gold: 0, pending: 40 }, {}).error === 'bad direction');

check('wallet-proof-roundtrip', (function () {
  var kp = Keypair.generate();
  var addr = kp.publicKey.toBase58();
  var nonce = 'ab'.repeat(16);
  var sig = Proof.signLink(kp.secretKey, addr, 'player-key', nonce);
  return Proof.verifyLink(addr, 'player-key', nonce, sig) === true;
})());
check('wallet-proof-rejects-other-key', (function () {
  var kp = Keypair.generate();
  var addr = kp.publicKey.toBase58();
  var nonce = 'cd'.repeat(16);
  var sig = Proof.signLink(kp.secretKey, addr, 'player-key', nonce);
  return Proof.verifyLink(addr, 'someone-else', nonce, sig) === false;
})());
check('real-mint-beats-placeholder-flag', TC.withEnv({
  STRATUM_TOKEN_MINT: 'So11111111111111111111111111111111111111112',
  STRATUM_TOKEN_PLACEHOLDER: 'true'
}).placeholder === false);
check('wallet-proof-rejects-bad-nonce', (function () {
  var kp = Keypair.generate();
  var addr = kp.publicKey.toBase58();
  var sig = Proof.signLink(kp.secretKey, addr, 'player-key', 'ef'.repeat(16));
  return Proof.verifyLink(addr, 'player-key', 'not-hex', sig) === false;
})());

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
