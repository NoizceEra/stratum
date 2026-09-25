/**
 * create-strm-mint.mjs — create the official STRATUM SPL mint on Solana.
 *
 * OPERATOR-RUN, NOT AGENT-RUN. This spends real SOL (mint creation + metadata)
 * and creates a real, permanent token supply — run it yourself, from your own
 * funded wallet, never from inside a coding session.
 *
 *   1. Fund a wallet with a little SOL (mint rent + fees, well under 0.1 SOL).
 *   2. MINT_AUTHORITY_SECRET='[...]' node scripts/create-strm-mint.mjs
 *      (secret = base58 export or JSON array of your funded wallet)
 *   3. Copy the printed mint address into the server's .env as STRATUM_TOKEN_MINT.
 *
 * What it does:
 *   - creates an SPL mint with 9 decimals, mint authority = your wallet
 *   - mints `initialSupply` whole STRATUM to YOUR wallet's ATA (pass --supply N)
 *   - optionally revokes the mint authority (--lock) so supply is fixed forever,
 *     matching the fixed-supply promise in README.md's Commerce section
 *
 * Env:
 *   MINT_AUTHORITY_SECRET   secret key of the funded wallet (base58 or JSON array)
 *   STRATUM_SOLANA_RPC      defaults to https://api.mainnet-beta.solana.com
 *   STRATUM_TOKEN_DECIMALS  defaults to 9
 *
 * Flags:
 *   --supply N   whole-token supply to mint (default 1000000000)
 *   --lock       revoke mint authority after minting (fixed supply, recommended)
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType } from '@solana/spl-token';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  const zeros = (s.match(/^1*/) || [''])[0].length;
  let bytes = [0];
  for (const ch of s) {
    const c = B58.indexOf(ch);
    if (c < 0) throw new Error('bad base58 in secret');
    let carry = c;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = [];
  for (let z = 0; z < zeros; z++) out.push(0);
  for (let k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
  while (out.length > 1 && out[0] === 0 && zeros === 0) out.shift();
  return Uint8Array.from(out);
}

function loadKey(secret) {
  const t = String(secret || '').trim();
  if (t.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(t)));
  return Keypair.fromSecretKey(b58decode(t));
}

const args = process.argv.slice(2);
const supplyFlag = args.indexOf('--supply');
const supply = supplyFlag >= 0 ? Number(args[supplyFlag + 1]) : 1000000000;
const lock = args.includes('--lock');
if (!Number.isFinite(supply) || supply <= 0 || !Number.isInteger(supply)) {
  console.error('bad --supply (want a positive whole-token integer)');
  process.exit(1);
}

const rpc = process.env.STRATUM_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const decimals = Number(process.env.STRATUM_TOKEN_DECIMALS || '9');
const payer = loadKey(process.env.MINT_AUTHORITY_SECRET);
if (!payer) { console.error('set MINT_AUTHORITY_SECRET first'); process.exit(1); }

const connection = new Connection(rpc, 'confirmed');
console.log('payer ' + payer.publicKey.toBase58());

const mint = await createMint(connection, payer, payer.publicKey, null, decimals);
console.log('mint ' + mint.toBase58());

const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
const raw = BigInt(supply) * (10n ** BigInt(decimals));
await mintTo(connection, payer, mint, ata.address, payer.publicKey, raw);
console.log('minted ' + supply + ' STRATUM to ' + ata.address.toBase58());

if (lock) {
  await setAuthority(connection, payer, mint, null, AuthorityType.MintTokens);
  console.log('mint authority revoked — supply is now fixed forever');
}

console.log('\nNext: set STRATUM_TOKEN_MINT=' + mint.toBase58() + ' in the server .env');
