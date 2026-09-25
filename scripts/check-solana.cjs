'use strict';
/**
 * Report whether this machine can settle STRATUM. Prints public addresses and
 * balances only — never the signer secret.
 *
 *   node scripts/check-solana.cjs
 */
const fs = require('fs');
const path = require('path');
const { Keypair, Connection, PublicKey } = require('@solana/web3.js');

const root = path.join(__dirname, '..');
const env = {};
const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
for (const line of text.split(/\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i).trim()] = v;
}

function b58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = 0; i < s.length; i++) {
    const c = A.indexOf(s[i]);
    if (c < 0) return null;
    let carry = c;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = [];
  for (let z = 0; z < zeros; z++) out.push(0);
  for (let k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
  while (out.length > 1 && out[0] === 0 && zeros === 0) out.shift();
  return Uint8Array.from(out);
}

const keyStr = env.STRATUM_CLAIM_SIGNER_KEY || '';
let secret = null;
if (keyStr.trim().startsWith('[')) secret = Uint8Array.from(JSON.parse(keyStr));
else secret = b58decode(keyStr.trim());
if (!secret || secret.length !== 64) {
  console.log(JSON.stringify({ ok: false, reason: 'signer key missing or malformed' }));
  process.exit(1);
}
const kp = Keypair.fromSecretKey(secret);
const derived = kp.publicKey.toBase58();
const configured = env.STRATUM_TREASURY_ADDRESS;
const rpc = env.STRATUM_SOLANA_RPC;
const mint = env.STRATUM_TOKEN_MINT;
const conn = new Connection(rpc, 'confirmed');

(async () => {
  const out = {
    cluster: env.STRATUM_CLUSTER,
    rpcHost: new URL(rpc).host,
    signerMatchesTreasury: derived === configured,
    treasury: configured,
    signerPublic: derived,
    mint: mint,
    mintIsAddress: false,
    sol: null,
    mintOnChain: null,
    rpcOk: false
  };
  try { out.mintIsAddress = new PublicKey(mint).toBytes().length === 32; } catch (e) { out.mintIsAddress = false; }
  try {
    out.sol = (await conn.getBalance(new PublicKey(configured))) / 1e9;
    out.signerSol = (await conn.getBalance(kp.publicKey)) / 1e9;
    out.rpcOk = true;
    if (out.mintIsAddress) out.mintOnChain = !!(await conn.getAccountInfo(new PublicKey(mint)));
  } catch (e) {
    out.rpcError = String(e && e.message || e).slice(0, 180);
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.rpcOk ? 0 : 1);
})();
