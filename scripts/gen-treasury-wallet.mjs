/**
 * One-shot treasury wallet generator (Solana).
 * Prints JSON { address, secretKeyBase58, secretKeyArray } to stdout.
 * Never writes to disk itself — paste the secret into the server's local .env
 * as STRATUM_CLAIM_SIGNER_KEY (gitignored), never into chat/logs/notes.
 *
 *   node scripts/gen-treasury-wallet.mjs
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();
process.stdout.write(JSON.stringify({
  address: kp.publicKey.toBase58(),
  secretKeyBase58: bs58.encode(Buffer.from(kp.secretKey)),
  secretKeyArray: JSON.stringify(Array.from(kp.secretKey)),
  method: 'solana-keypair'
}) + '\n');
