# STRM token mint (Solana SPL)

STRM is an SPL token on Solana mainnet-beta: 9 decimals, fixed supply, mint
authority revoked at creation so nobody — not even the operator — can inflate
it later.

**This mint has not been created yet.** `src/token-config.js` still carries the
sentinel `STRM_MINT_NOT_YET_DEPLOYED`, which is deliberately not a valid address,
so `src/chain-adapter.js` refuses to settle and the holder-bonus stays at 1.0x.
Nothing settles, mints, or transfers until the real mint address is wired in.

**Creating the mint is not something a coding session does.** It's an
irreversible on-chain action, it spends real SOL from a real wallet, and it
creates a real, permanent supply of value — that's the operator's own action,
with their own wallet. `scripts/create-strm-mint.mjs` is the walkthrough turned
into a script; the rest of this file is what to do around it.

## Creating the mint

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

## Wiring the mint into the game

1. Set `STRATUM_TOKEN_MINT=<mint>` in the server's `.env` (this alone flips
   `token-config.js`'s `placeholder` flag to `false` — see `withEnv()`).
2. Verify `chain-adapter.js` picks it up: boot the server and check the startup
   log line `[commerce] settlement live=...` — it only reads `true` once the
   mint is real AND the treasury/secret/RPC are all configured.
3. **Fund the treasury** — real settlement transfers STRM FROM the treasury's
   associated token account TO a claiming player's associated token account
   (see `chain-adapter.js`). Send part of the freshly minted supply to the
   treasury address (`EU7HUWHHjqAirfy9SkXmDUYPVop8kQUyiKrCLboWMoNo`, per
   `token-config.js` — confirm this is still current), plus a little SOL for
   transaction fees. An unfunded treasury refuses claims with
   `insufficient_treasury_balance` instead of burning SOL on doomed sends.
4. Update the placeholder note in `README.md`'s Commerce section once live.

## What this mint deliberately does not include

No freeze authority (set to `null` at creation), no ongoing mint (revoked with
`--lock`), no transfer fee. A simple, standard, unstoppable SPL token is a
stronger promise to players than one an operator can freeze or inflate later.
If real requirements emerge that need one of those, that's a new, deliberate
mint — not a change bolted on after supply already exists.

## Legacy: the EVM contract

`legacy-evm-StratumToken.sol` is the pre-switch ERC-20 drafted for Robinhood
Chain. It was never deployed and is now superseded — kept for history only.
Nothing in the server, client, or scripts references it.
