/**
 * wallet-proof.js — prove a Solana wallet owns a link or a resume.
 *
 * The browser asks the injected wallet to sign a fixed UTF-8 message. The
 * server checks that ed25519 signature against the address. Play does not
 * need this. Claim and convert need a linked wallet; resuming the colonist
 * that already belongs to a wallet needs a valid signature, so a typed-in
 * address cannot take over someone else's character.
 *
 * Node-only (node:crypto verify). Not loaded by the browser.
 */
'use strict';
const crypto = require('node:crypto');
const { PublicKey } = require('@solana/web3.js');

/** DER SPKI prefix for a 32-byte Ed25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** PKCS8 prefix for a 32-byte Ed25519 seed. Tests and scripts sign with this. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function messageFor(address, playerKey, nonce) {
  return 'STRATUM\nwallet\n' + address + '\n' + playerKey + '\n' + nonce;
}

function verifyLink(address, playerKey, nonce, signatureB64) {
  try {
    if (typeof address !== 'string' || typeof playerKey !== 'string' || typeof nonce !== 'string') return false;
    if (!/^[0-9a-f]{32}$/.test(nonce)) return false;
    if (typeof signatureB64 !== 'string' || !signatureB64.length) return false;
    var sig = Buffer.from(signatureB64, 'base64');
    if (sig.length !== 64) return false;
    var pk = new PublicKey(address);
    var der = Buffer.concat([SPKI_PREFIX, Buffer.from(pk.toBytes())]);
    var key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    var msg = Buffer.from(messageFor(address, playerKey, nonce), 'utf8');
    return crypto.verify(null, msg, key, sig);
  } catch (e) {
    return false;
  }
}

/** Sign `messageFor(...)` with a 64-byte Solana secret key. Returns base64. */
function signLink(secretKey, address, playerKey, nonce) {
  var seed = secretKey instanceof Uint8Array ? secretKey.subarray(0, 32) : Buffer.from(secretKey).subarray(0, 32);
  var key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8'
  });
  var msg = Buffer.from(messageFor(address, playerKey, nonce), 'utf8');
  return crypto.sign(null, msg, key).toString('base64');
}

module.exports = {
  messageFor: messageFor,
  verifyLink: verifyLink,
  signLink: signLink
};
