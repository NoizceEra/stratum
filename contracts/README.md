# STRATUM token mint (Solana SPL)

**The mint is live**, verified on mainnet-beta 2026-09-24:
`EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU` — "Planet Stratum" / `STRATUM` on
its own on-chain metadata, `STRATUM` as this game's display ticker. It is a
**Token-2022** mint (not the legacy Token program — see `src/chain-adapter.js`'s
header for why that distinction matters to any code that builds a transfer),
6 decimals, fixed supply (mint authority is `null` — nobody, not even the
operator, can inflate it), no freeze authority, **with a 1% transfer-fee
extension** (the token program itself withholds 1% on every transfer — this is
the mint's own on-chain config, not something STRATUM's code adds, and not
something `--lock`ing a mint authority affects).

That last point is a deliberate correction to keep here: the design goal
described below under "what this mint deliberately does not include" (no
transfer fee) was the plan for a mint created via THIS repo's own
`scripts/create-strm-mint.mjs`. The mint actually in use has a transfer fee, so
it was evidently created some other way (a token launcher, not this script) —
if a genuinely fresh, script-created mint is ever needed instead, the section
below still describes how, but it does not describe how the current STRATUM mint
came to exist.

`src/token-config.js` now carries this real address as its default (`isAddr()`
already treats it as live, `placeholder: false`) — nothing further is needed to
wire the mint itself in. What's still missing for real settlement is a funded
treasury and `STRATUM_CLAIM_SIGNER_KEY` (see "Wiring the mint into the game"
below, which is still accurate for that half).

## Creating a (different) mint from scratch

The rest of this section is kept for reference — for standing up a fresh mint
via this repo's own script, e.g. for a fork or a testnet rehearsal. It is not
what produced the STRATUM mint above.

1. Fund a wallet with a little SOL (mint rent + a few transaction fees — well
   under 0.1 SOL).
2. From the project root:
   ```
   MINT_AUTHORITY_SECRET='[...]' node scripts/create-strm-mint.mjs --supply 1000000000 --lock
   ```
   `MINT_AUTHORITY_SECRET` is your funded wallet's secret (base58 export or JSON
   array). `--supply` is the whole-token supply (default one billion).
   `--lock` revokes the mint authority afterwards — recommended, this is what
   makes the fixed-supply promise real.
3. Copy the printed mint address.

## Wiring a (different) mint into the game

Already done for the current STRATUM mint (baked into `token-config.js`'s
defaults). This is what it took, for reference or for wiring in a different one:

1. Set `STRATUM_TOKEN_MINT=<mint>` (and `STRATUM_TOKEN_DECIMALS=<its real
   decimals>` — do not assume 9) as an env var, or update `token-config.js`'s
   `DEFAULTS` directly the way the current mint is wired. Either flips
   `token-config.js`'s `placeholder` flag to `false` — see `withEnv()`.
2. Verify `chain-adapter.js` picks it up: boot the server and check the startup
   log line `[commerce] settlement live=...` — it only reads `true` once the
   mint is real AND the treasury/secret/RPC are all configured.
3. **Fund the treasury** — real settlement transfers STRATUM FROM the treasury's
   associated token account TO a claiming player's associated token account
   (see `chain-adapter.js`). Send part of the supply to the treasury address
   (`EU7HUWHHjqAirfy9SkXmDUYPVop8kQUyiKrCLboWMoNo`, per `token-config.js` —
   confirm this is still current), plus a little SOL for transaction fees. An
   unfunded treasury refuses claims with `insufficient_treasury_balance`
   instead of burning SOL on doomed sends.
4. Set `STRATUM_CLAIM_SIGNER_KEY` on the host (never in a committed `.env`) —
   the treasury's own secret key, so it can actually sign the transfer.

## What a mint created via THIS script deliberately does not include

No freeze authority (set to `null` at creation), no ongoing mint (revoked with
`--lock`), no transfer fee. A simple, standard, unstoppable SPL token is a
stronger promise to players than one an operator can freeze or inflate later.
If real requirements emerge that need one of those, that's a new, deliberate
mint — not a change bolted on after supply already exists.

**This is not a description of the current live STRATUM mint**, which does carry a
1% transfer fee (see the top of this file) — that mint predates this script
being used, or was created by some other tool entirely.

## Legacy: the EVM contract

`legacy-evm-StratumToken.sol` is the pre-switch ERC-20 drafted for Robinhood
Chain. It was never deployed and is now superseded — kept for history only.
Nothing in the server, client, or scripts references it.
