# STRM token contract

`StratumToken.sol` is the official STRATUM game token — a standard, fixed-supply,
burnable ERC-20 built on OpenZeppelin (see the contract's own header comment for why
this is the one place the project uses a third-party library instead of hand-rolling).

**This contract has not been deployed anywhere.** The address currently wired into
`src/token-config.js` is a placeholder pointing at an unrelated, already-deployed
contract on Robinhood Chain (see `README.md`'s Commerce section) — it is not STRM and
must never be used for real settlement.

**Deploying is not something this coding session does.** It's an irreversible on-chain
action, it spends real gas from a real wallet, and it creates a real, permanent supply of
value — that's the operator's own action, with their own wallet, not something to run
from inside an agent session. The rest of this file is the walkthrough for doing it
yourself.

## Compiling / verifying the source

The contract was compiled and its bytecode/ABI checked as part of building it (fixed
9,154-byte deployed bytecode, well under the 24KB EIP-170 limit; ABI confirms no `mint`
function exists anywhere in the inheritance chain — supply really is fixed at deploy).
To re-verify yourself with a local toolchain:

```bash
npm install --no-save @openzeppelin/contracts@5.1.0 solc@0.8.24
# then compile contracts/StratumToken.sol with solc, resolving
# @openzeppelin/contracts/... imports from node_modules
```

Or just paste the contract into [Remix](https://remix.ethereum.org) — its compiler
resolves `@openzeppelin/contracts` imports automatically from npm, no local setup needed.
This is also the easiest path to actually deploy (next section).

## Deploying via Remix (no local toolchain needed)

1. Open **[remix.ethereum.org](https://remix.ethereum.org)**, create a new file, paste in
   `StratumToken.sol`.
2. **Solidity Compiler** tab → compiler version `0.8.24` (or any `0.8.24+`) → Compile.
   Remix pulls the `@openzeppelin/contracts` imports automatically.
3. **Deploy & Run Transactions** tab → Environment: **Injected Provider** (MetaMask or
   whatever wallet holds the deployer key — should be the real treasury wallet, or a
   wallet that will immediately transfer ownership/supply to it).
4. Before deploying, **add Robinhood Chain to your wallet** as a custom network if it
   isn't already there:
   - Chain ID: `4663`
   - RPC URL: `https://rpc.mainnet.chain.robinhood.com`
   - Currency symbol: `ETH`
   - Block explorer: `https://robinhoodchain.blockscout.com`

   (These are the values currently in `src/token-config.js` — reachability and the chain
   ID were independently verified against the live RPC as part of this work; see the
   README.md Commerce section for that check. Still worth re-confirming yourself before
   sending a real deploy transaction.)
5. Fill in the constructor args:
   - `initialSupply` — whole-token amount, e.g. `1000000000` for one billion STRM. The
     contract multiplies this by `10**18` itself — do not pre-scale it.
   - `treasury` — the real STRATUM treasury address
     (`0xE8896562619Fe0276d65952b51dcC11C17b8C144`, per `token-config.js` — confirm this
     is still current before using it).
6. Deploy. Confirm the transaction in your wallet.
7. Copy the deployed contract address.

## Wiring the real address into the game

Once deployed and you have the address:

1. Set `STRATUM_TOKEN_ADDRESS=0x...` in the server's `.env` (this alone flips
   `token-config.js`'s `placeholder` flag to `false` — see `withEnv()`).
2. Verify `chain-adapter.js` picks it up: boot the server and check the startup log line
   `[commerce] settlement live=...` — it only reads `true` once the token is real AND the
   treasury/signer/rpc are all configured (see `chain-adapter.js`'s `isConfigured()`).
3. **Fund the treasury** — real settlement transfers FROM the treasury's on-chain balance
   TO a claiming player's wallet (see `chain-adapter.js`). If the deploy sent the full
   supply straight to the treasury address (step 5 above), this is already done.
4. Update the placeholder note in `README.md`'s Commerce section and the `| Placeholder
   token CA |` table row once this is live — that table exists specifically to be edited
   the day this stops being a placeholder.

## What this contract deliberately does not include

No pause, no blocklist, no upgradeability, no transfer fee, no ongoing mint. See the
contract's own header for the reasoning — a simple, permanent, unstoppable ERC-20 is a
stronger promise to players than one an operator can freeze or inflate later. If real
requirements emerge that need one of those, that's a new, deliberate contract version,
not a change bolted onto this one after supply already exists.
