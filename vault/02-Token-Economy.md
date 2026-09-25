---
tags: [stratum, token-economy, solana]
---

# Token Economy

STRATUM has a real Solana token backing it — not a placeholder, not a testnet
sentinel. Treat every number below as **live and money-real**, and reverify before
acting on it (see "How to recheck" at the bottom) — balances and config drift, this
page doesn't update itself.

## The mint

| Field | Value |
|---|---|
| Address | `EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU` |
| Name / symbol (on-chain metadata) | "Planet Stratum" / `STRATUM` |
| Cluster | Solana mainnet-beta |
| Program | **Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) — NOT the legacy Token program |
| Decimals | **6** (not 9 — a wrong assumption here silently encodes every amount 1000x too large) |
| Supply | ~999,997,192.8 STRATUM, fixed |
| Mint authority | `null` — nobody can inflate supply |
| Freeze authority | `null` |
| Transfer fee extension | **1% withheld on every transfer** — the token program's own on-chain config, not something STRATUM's code adds or can remove |

**Why Token-2022 matters practically:** `@solana/spl-token`'s helper functions
(`getAssociatedTokenAddressSync`, `createAssociatedTokenAccountInstruction`,
transfer instructions) silently default to the legacy `TOKEN_PROGRAM_ID` unless you
explicitly pass `TOKEN_2022_PROGRAM_ID`. `chain-adapter.js` reads the mint account's
own `owner` field at settlement time and picks the right program — this is not
optional boilerplate, it's the fix for a bug that would have silently failed (or
worse, half-succeeded against the wrong program) every real transfer.

## Treasury & signer (current, as of 2026-09-24)

| Field | Value |
|---|---|
| Treasury address (public) | `AYMwwmPxucSXDoc3Qx7prVnH5rP3XpgBDJVENed4A9mo` |
| Balance at last check | ~0.31 SOL, ~20.2M STRATUM (its ATA: `98sxJv9AJKr2EfhxjM7PukXtcn8BvtgwhWcqCRRahdKk`) |
| Signer | `STRATUM_CLAIM_SIGNER_KEY` in Railway production — controls the SAME wallet as the treasury address above |

**This treasury address is the second one used.** The original hardcoded treasury
(`EU7HUWHHjqAirfy9SkXmDUYPVop8kQUyiKrCLboWMoNo`) had **0 SOL and no STRATUM
associated token account at all** — a claim against it would have failed with
`insufficient_treasury_balance` forever. When a real signer key was added to
Railway, it turned out to control a *different*, already-funded wallet — so the
treasury address was swapped to match, everywhere (source default in
`token-config.js`, `.env.example`, README, Railway env). See [[05-Decisions-Log]]
for the full story of how this was discovered (it involves `server.js`'s own
`.env` loader — see [[07-Testing]]).

**Never assume treasury == signer without checking.** They only match because
someone deliberately swapped the address to line up with the key. If either one
changes independently in the future, they can drift apart again silently — the
server will boot fine either way (`signer=true`/`treasury=true` are independent
booleans in the boot log), it just won't be able to actually pay anyone.

## Fees (live, as of last check)

`parcel=250bps shop=250bps claim=250bps convert=250bps` — 2.5% each. Read from
Railway env / `server.js` boot log (`[commerce] fees ...`), not hardcoded here as
gospel — these are operator-tunable.

## The claim/convert pipeline

- **Convert** (gold → pending STRATUM) is a pure in-game ledger operation. No
  blockchain transaction, no real money risk to demo or test freely.
- **Claim** (pending STRATUM → the player's own wallet) is where `chain-adapter.js`
  attempts a REAL, irreversible Token-2022 `TransferChecked` from the treasury's
  ATA to the player's ATA (creating the player's ATA in the same transaction if it
  doesn't exist). **As of 2026-09-24 this is fully live** — signer configured,
  treasury funded. A claim on production now moves real crypto. See
  [[08-Agent-Playbook]] for the standing rule about never triggering this
  autonomously.
- `chain-adapter.js`'s `isConfigured(env)` gates all of this: RPC + mint + treasury
  + signer all present, `settlementImplemented` true, and the mint NOT flagged as
  placeholder. Missing/ambiguous config always resolves to `not_configured` /
  queued — nothing is ever silently lost, a claim that can't settle just waits.

## How to recheck any of this

```bash
# Boot log (also shows the derived signer public key, never the secret):
# look for lines starting [commerce] in Railway deploy logs

# On-chain, read-only, no key needed:
# SOL balance:   BlockchainQuery.solana_get_balance(address)
# STRATUM balance: BlockchainQuery.solana_get_balance(address, mint_address=<mint above>)
#   (if that hits an RPC secondary-index limitation on this mint, derive the ATA
#   locally via @solana/spl-token's getAssociatedTokenAddressSync with
#   TOKEN_2022_PROGRAM_ID, then solana_get_account on that address directly)
```

`chain-adapter.js`'s `describe(env)` is the code-level readiness check — pure,
synchronous, never returns the secret key value, does return a derived
`signerAddress` (safe — a public key, not the secret) so you can confirm which
wallet a configured signer actually controls without ever touching the raw key.
