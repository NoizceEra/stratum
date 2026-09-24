/**
 * chain-adapter.js — the ONE place a real on-chain STRM payout happens.
 *
 * WHY THIS FILE EXISTS
 *   src/rewards.js pays players soft `gold` + hard `token` units into `token_ledger.pending`.
 *   Turning pending into a real chain transfer needs a funded treasury wallet and a signer.
 *   The treasury *address* is public (`token-config.js` / STRATUM_TREASURY_ADDRESS).
 *   The treasury *secret key* lives only in a local, gitignored `.env` on the operator's
 *   machine, loaded into the host as STRATUM_CLAIM_SIGNER_KEY (or alias STRATUM_TREASURY_KEY).
 *   This module never logs or returns that key — it's read from env at call time, parsed
 *   into a Keypair for one settleClaim() call, and never cached.
 *
 * THE CHAIN: SOLANA (SPL TOKEN)
 *   Settlement is an SPL-token transfer: treasury's associated token account (ATA) ->
 *   player's ATA for the STRM mint, creating the player's ATA inside the same
 *   transaction when it doesn't exist yet. Reads are plain RPC `getTokenAccountsByOwner`
 *   calls — no signer, no queue. This file is the deliberate, scoped exception to the
 *   project's hand-rolled habit: it uses `@solana/web3.js` + `@solana/spl-token` (see
 *   package.json) to build and send that transaction. Hand-rolling ed25519 signing +
 *   Solana's binary transaction format for code that moves real funds is exactly the
 *   wrong place to save a dependency. The base58 decoder below is the only hand-rolled
 *   crypto-adjacent piece, and it never touches signatures — it only decodes the secret
 *   key bytes for Keypair.fromSecretKey to consume. This file is Node-only.
 *
 * SAFETY GATES — settleClaim() only ever attempts a real transfer when isConfigured(env)
 * is true, which requires ALL of:
 *   - a well-formed RPC URL, mint address, treasury address, and signer key (describe())
 *   - settlementImplemented (true — the transfer code below exists and is wired)
 *   - the mint is NOT flagged as the placeholder (STRATUM_TOKEN_IS_PLACEHOLDER)
 *   Missing or ambiguous env for that last flag is read as "yes, it's still the placeholder" —
 *   an unset/garbled flag must never accidentally unlock a transfer against the sentinel
 *   (see README.md's Commerce note). Any other case resolves
 *   { ok:false, reason:'not_configured', ... }, same as always, and the caller (server.js)
 *   never decrements pending on that answer — nothing is ever lost.
 *
 * TESTABILITY WITHOUT EVER TOUCHING A REAL CHAIN
 *   settleClaim()/readBalance() take an optional `deps` argument —
 *   { makeConnection, makeKeypair } — used only by test-chain-adapter.js to inject fakes.
 *   Production code (server.js) never passes `deps`, so it always gets the real
 *   Connection/Keypair constructors below. ATA derivation and instruction building run
 *   for real even against fakes (they're pure), so `npm test` exercises the genuine
 *   transfer-construction path fully offline: no test in this repo ever signs or
 *   broadcasts a real transaction, and none should.
 *
 * ONE TREASURY WALLET, ONE TRANSACTION AT A TIME
 *   The treasury is a single signer. Two settleClaim() calls racing each other could
 *   otherwise build on the same recent blockhash / collide on the fee-payer's sequence.
 *   The fix is a module-level promise-chain queue (`sendQueue`, below `settleClaim`):
 *   every call's actual chain-touching work (balance check + build + send + confirm) is
 *   appended to that chain and only starts once every earlier call has fully finished.
 *   Validation and the isConfigured() gate stay OUTSIDE the queue — those never touch
 *   the signer, so a claim that's going to be refused anyway answers immediately.
 *
 * CONTRACT
 *   - `describe()` / `isConfigured()` are pure, synchronous, given an env snapshot.
 *   - `settleClaim()` and `readBalance()` always resolve (never reject/throw) — every
 *     failure path returns a typed { ok:false, reason, detail } instead.
 *   - Success resolves { ok:true, txHash:<base58 signature> } (`txHash` keeps the
 *     server.js claim_requests column name stable across the chain switch).
 */
'use strict';
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction
} = require('@solana/spl-token');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Hand-rolled base58 decode — key-material decoding only, never signatures. */
function b58decode(s) {
  if (typeof s !== 'string' || !s.length) return null;
  var zeros = 0;
  while (zeros < s.length && s.charAt(zeros) === '1') zeros++;
  var bytes = [0];
  for (var i = 0; i < s.length; i++) {
    var c = B58_ALPHABET.indexOf(s.charAt(i));
    if (c < 0) return null;
    var carry = c;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  var out = [];
  for (var z = 0; z < zeros; z++) out.push(0);
  for (var k = bytes.length - 1; k >= 0; k--) out.push(bytes[k]);
  // Strip the single spurious leading zero the algorithm above emits when the
  // input has no '1' prefix (bytes[] starts as [0]).
  while (out.length > 1 && out[0] === 0 && zeros === 0) out.shift();
  return Uint8Array.from(out);
}

/**
 * Parse STRATUM_CLAIM_SIGNER_KEY in either accepted form:
 *   - base58-encoded 64-byte secret key (Phantom-style export), or
 *   - JSON array of 64 numbers (solana-keygen / Keypair.generate() export).
 * Returns a 64-byte Uint8Array, or null when the value is absent/malformed.
 */
function parseSecretKey(s) {
  if (typeof s !== 'string' || !s.length) return null;
  var t = s.trim();
  if (t.charAt(0) === '[') {
    try {
      var arr = JSON.parse(t);
      if (!Array.isArray(arr) || arr.length !== 64) return null;
      var u = new Uint8Array(64);
      for (var i = 0; i < 64; i++) {
        var n = arr[i];
        if (typeof n !== 'number' || (n | 0) !== n || n < 0 || n > 255) return null;
        u[i] = n;
      }
      return u;
    } catch (e) { return null; }
  }
  var raw = b58decode(t);
  if (!raw || raw.length !== 64) return null;
  return raw;
}

function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch (e) { return false; }
}

/**
 * Readiness snapshot. Never includes the secret key value.
 *
 * Env knobs:
 *   STRATUM_SOLANA_RPC / STRATUM_RPC_URL / STRATUM_CLAIM_RPC_URL
 *   STRATUM_TOKEN_MINT / STRATUM_TOKEN_ADDRESS / STRATUM_CLAIM_TOKEN_ADDR
 *   STRATUM_TREASURY_ADDRESS
 *   STRATUM_CLAIM_SIGNER_KEY / STRATUM_TREASURY_KEY  (presence only)
 *   STRATUM_TOKEN_IS_PLACEHOLDER  ('0' = real mint; anything else = still the placeholder)
 *   STRATUM_TOKEN_DECIMALS  (SPL: 0..9, falls back to 6 — the real STRM mint's own
 *                            decimals — if missing/out of range)
 */
function describe(env) {
  var e = (env && typeof env === 'object') ? env : {};
  var rpc = e.STRATUM_SOLANA_RPC || e.STRATUM_CLAIM_RPC_URL || e.STRATUM_RPC_URL;
  var mint = e.STRATUM_TOKEN_MINT || e.STRATUM_CLAIM_TOKEN_ADDR || e.STRATUM_TOKEN_ADDRESS;
  var treasury = e.STRATUM_TREASURY_ADDRESS;
  var key = e.STRATUM_CLAIM_SIGNER_KEY || e.STRATUM_TREASURY_KEY;
  return {
    rpcConfigured: typeof rpc === 'string' && /^https?:\/\//i.test(rpc),
    mintConfigured: isPubkey(mint),
    treasuryConfigured: isPubkey(treasury),
    signerPresent: parseSecretKey(key) !== null,
    // Conservative on purpose: only an explicit '0' counts as "this is the real mint".
    tokenIsPlaceholder: e.STRATUM_TOKEN_IS_PLACEHOLDER !== '0',
    settlementImplemented: true
  };
}

function isConfigured(env) {
  var d = describe(env);
  return d.rpcConfigured && d.mintConfigured && d.treasuryConfigured &&
    d.signerPresent && d.settlementImplemented && !d.tokenIsPlaceholder;
}

function tokenDecimals(env) {
  var e = (env && typeof env === 'object') ? env : {};
  var dec = Number(e.STRATUM_TOKEN_DECIMALS);
  // 6, not the SPL ceiling of 9 — the real STRM mint uses 6 decimals (verified
  // on-chain 2026-09-24), so an unset/invalid env var must fall back to the actual
  // mint's decimals, not a generic maximum. Getting this wrong would encode every
  // real transfer amount 1000x too large against this specific mint.
  return (Number.isFinite(dec) && dec >= 0 && dec <= 9) ? (dec | 0) : 6;
}

function defaultDeps() {
  return {
    makeConnection: function (rpcUrl) { return new Connection(rpcUrl, 'confirmed'); },
    makeKeypair: function (secretStr) {
      return Keypair.fromSecretKey(parseSecretKey(secretStr));
    },
    /**
     * Sign + send + confirm one Transaction. Written against the generic
     * Connection surface only (getLatestBlockhash / sendRawTransaction /
     * confirmTransaction) so offline fakes can stand in for the network.
     */
    sendAndConfirm: async function (tx, connection, signers) {
      var lh = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = lh.blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign.apply(tx, signers);
      var sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(
        { signature: sig, blockhash: lh.blockhash, lastValidBlockHeight: lh.lastValidBlockHeight },
        'confirmed'
      );
      return sig;
    }
  };
}

function mintOf(env) {
  var e = env;
  return e.STRATUM_TOKEN_MINT || e.STRATUM_CLAIM_TOKEN_ADDR || e.STRATUM_TOKEN_ADDRESS;
}

function rpcOf(env) {
  var e = env;
  return e.STRATUM_SOLANA_RPC || e.STRATUM_CLAIM_RPC_URL || e.STRATUM_RPC_URL;
}

function secretOf(env) {
  var e = env;
  return e.STRATUM_CLAIM_SIGNER_KEY || e.STRATUM_TREASURY_KEY;
}

/** SPL token-account `amount` (u64 LE at offset 64) from raw account data. */
function readTokenAmount(data) {
  try {
    var buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 72) return null;
    return buf.readBigUInt64LE(64);
  } catch (e) { return null; }
}

/**
 * The actual chain-touching work for one claim: load the treasury signer, check it
 * can afford the claim, build treasury-ATA -> player-ATA transfer (creating the
 * player ATA in the same transaction when missing), send, confirm. Never called
 * directly — always through the `sendQueue` below. Always resolves (never rejects).
 */
async function sendToChain(req, env, amount, deps) {
  var dec = tokenDecimals(env);
  var fns = Object.assign(defaultDeps(), deps || {});

  var connection, treasury;
  try {
    connection = fns.makeConnection(rpcOf(env));
    treasury = fns.makeKeypair(secretOf(env));
  } catch (eSigner) {
    return { ok: false, reason: 'signer_error', detail: eSigner && eSigner.message };
  }

  var mint, player;
  try {
    mint = new PublicKey(mintOf(env));
    player = new PublicKey(req.wallet);
  } catch (eAddr) {
    return { ok: false, reason: 'bad_request', detail: 'invalid mint or wallet address' };
  }

  var amountRaw;
  try {
    amountRaw = BigInt(amount) * (10n ** BigInt(dec));
    if (amountRaw <= 0n) throw new Error('non-positive');
  } catch (eParse) {
    return { ok: false, reason: 'bad_request', detail: 'could not encode claim amount for ' + dec + ' decimals' };
  }

  // Pre-flight: the mint must exist. Read its OWNING program here, first — a mint can
  // live under either the legacy Token program or Token-2022 (STRATUM's own STRM mint
  // is Token-2022, with a transfer-fee extension), and every account/instruction below
  // derives differently depending on which one owns it. Hardcoding legacy TOKEN_PROGRAM_ID
  // would silently derive the WRONG associated-token-account addresses and build
  // instructions the mint's own program rejects — this is detected from the chain itself
  // so the same code keeps working correctly if the mint is ever rotated.
  var programId, mintInfo;
  try {
    mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
      return { ok: false, reason: 'bad_mint', detail: 'STRM mint not found on this cluster' };
    }
    programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  } catch (eMint) {
    return { ok: false, reason: 'rpc_error', detail: 'could not read mint account: ' + (eMint && eMint.message) };
  }

  var treasuryAta, playerAta;
  try {
    treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey, false, programId);
    playerAta = getAssociatedTokenAddressSync(mint, player, false, programId);
  } catch (eAta) {
    return { ok: false, reason: 'bad_request', detail: 'could not derive token accounts' };
  }

  // The treasury ATA must hold enough STRM. Refusing here avoids paying SOL for a
  // guaranteed-to-fail transaction. Note tBal reads the RAW account balance — under
  // Token-2022's transfer-fee extension the RECIPIENT receives slightly less than
  // amountRaw (a withheld fee the token program deducts automatically on every
  // transfer, currently 1% per this mint's on-chain config) even though the treasury
  // is debited the full amountRaw. That fee is the token's own protocol behavior, not
  // something this function tries to gross up or compensate for.
  try {
    var tInfo = await connection.getAccountInfo(treasuryAta);
    var tBal = tInfo ? readTokenAmount(tInfo.data) : 0n;
    if (tBal === null || tBal < amountRaw) {
      return { ok: false, reason: 'insufficient_treasury_balance', detail: 'treasury holds less STRM than this claim needs' };
    }
  } catch (eBal) {
    return { ok: false, reason: 'rpc_error', detail: 'could not read treasury balance: ' + (eBal && eBal.message) };
  }

  try {
    var tx = new Transaction();
    var pInfo = await connection.getAccountInfo(playerAta);
    if (!pInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        treasury.publicKey, playerAta, player, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID
      ));
    }
    // TransferChecked (not the bare Transfer instruction) — required by some Token-2022
    // extensions and always the safer choice: it asserts the mint + decimals match,
    // catching a misconfigured STRATUM_TOKEN_DECIMALS at the instruction level instead
    // of silently moving the wrong amount.
    tx.add(createTransferCheckedInstruction(
      treasuryAta, mint, playerAta, treasury.publicKey, amountRaw, dec, [], programId
    ));
    var sig = await fns.sendAndConfirm(tx, connection, [treasury]);
    return { ok: true, txHash: sig };
  } catch (eSend) {
    return { ok: false, reason: 'send_failed', detail: eSend && eSend.message };
  }
}

/**
 * Promise-chain mutex serializing every real send through the one treasury signer —
 * see the file header's "ONE TREASURY WALLET, ONE TRANSACTION AT A TIME" note.
 */
let sendQueue = Promise.resolve();
function enqueueSend(req, env, amount, deps) {
  const task = sendQueue.then(function () { return sendToChain(req, env, amount, deps); });
  sendQueue = task.catch(function () {});
  return task;
}

/**
 * Read-only on-chain STRM balance check for an arbitrary address — powers
 * src/holder-bonus.js's yield tier (a wallet holding more STRM earns a permanent reward
 * multiplier). Unlike settleClaim(), this needs no signer key and never queues: it's a
 * plain RPC read, not a transaction, so concurrent reads can't collide the way
 * concurrent sends could. Gated the same way as settlement — an RPC/mint
 * misconfiguration or the still-placeholder mint both resolve
 * { ok:false, reason:'not_configured' }, never a fabricated balance. Always resolves
 * (never rejects); returns `balance` as a whole-STRM-unit integer (decimals already
 * applied and floored), matching src/holder-bonus.js's tier table.
 */
async function readBalance(address, env, deps) {
  try {
    if (!isPubkey(address)) {
      return { ok: false, reason: 'bad_request', detail: 'invalid address' };
    }
    var d = describe(env);
    if (!d.rpcConfigured || !d.mintConfigured || d.tokenIsPlaceholder) {
      var missing = [];
      if (!d.rpcConfigured) missing.push('rpc');
      if (!d.mintConfigured) missing.push('mint');
      if (d.tokenIsPlaceholder) missing.push('a real (non-placeholder) token mint');
      return {
        ok: false,
        reason: 'not_configured',
        detail: 'balance read not live yet (missing: ' + missing.join(', ') + ')'
      };
    }

    var dec = tokenDecimals(env);
    var fns = Object.assign(defaultDeps(), deps || {});

    var connection;
    try {
      connection = fns.makeConnection(rpcOf(env));
    } catch (eConn) {
      return { ok: false, reason: 'signer_error', detail: eConn && eConn.message };
    }

    try {
      var owner = new PublicKey(address);
      var mint = new PublicKey(mintOf(env));
      var res = await connection.getParsedTokenAccountsByOwner(owner, { mint: mint });
      var total = 0n;
      var list = (res && res.value) || [];
      for (var i = 0; i < list.length; i++) {
        var amt = list[i] && list[i].account && list[i].account.data &&
          list[i].account.data.parsed && list[i].account.data.parsed.info &&
          list[i].account.data.parsed.info.tokenAmount;
        if (amt && typeof amt.amount === 'string') {
          try { total += BigInt(amt.amount); } catch (e) {}
        }
      }
      var human = Number(total / (10n ** BigInt(dec)));
      return { ok: true, balance: human };
    } catch (eRead) {
      return { ok: false, reason: 'rpc_error', detail: 'could not read balance: ' + (eRead && eRead.message) };
    }
  } catch (e) {
    return { ok: false, reason: 'internal_error', detail: e && e.message };
  }
}

/**
 * Attempt to settle one claim on-chain. Always resolves (never rejects).
 * Not configured (still the common case today — placeholder mint, see README.md)
 * -> { ok:false, reason:'not_configured', ... }; pending balance must stay put.
 * Configured -> a real SPL transfer (treasury ATA -> player ATA) of req.amountUnits
 * STRM, queued behind any other claim currently being sent.
 */
async function settleClaim(req, env, deps) {
  try {
    if (!req || typeof req !== 'object') {
      return { ok: false, reason: 'bad_request', detail: 'malformed claim request' };
    }
    if (!isPubkey(req.wallet)) {
      return { ok: false, reason: 'bad_request', detail: 'claim wallet invalid' };
    }
    var amount = req.amountUnits;
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
      return { ok: false, reason: 'bad_request', detail: 'claim amount invalid' };
    }
    var d = describe(env);
    if (!isConfigured(env)) {
      var missing = [];
      if (!d.rpcConfigured) missing.push('rpc');
      if (!d.mintConfigured) missing.push('mint');
      if (!d.treasuryConfigured) missing.push('treasury address');
      if (!d.signerPresent) missing.push('signer key');
      if (d.tokenIsPlaceholder) missing.push('a real (non-placeholder) token mint');
      return {
        ok: false,
        reason: 'not_configured',
        detail: 'on-chain settlement not live yet (missing: ' + missing.join(', ') +
          ') — claim is recorded; pending balance unchanged'
      };
    }

    return await enqueueSend(req, env, amount, deps);
  } catch (e) {
    return { ok: false, reason: 'internal_error', detail: e && e.message };
  }
}

module.exports = {
  describe: describe,
  isConfigured: isConfigured,
  settleClaim: settleClaim,
  readBalance: readBalance
};
