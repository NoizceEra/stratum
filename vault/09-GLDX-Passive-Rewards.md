---
tags: [stratum, gldx, token-economy, passive-rewards]
---

# GLDX / Passive Rewards

A second currency stream, added by a concurrent session and not yet reflected in
`ROADMAP.md` or `ROADMAP_COZY.md` — this is new scope neither roadmap document
anticipated, not a sub-phase of the Cozy pivot. As of this page's last update
(2026-09-25) the core math (`src/gldx-yield.js`, `src/token-sink.js`,
`src/tithes.js`, `src/vault.js`) is committed or ready to commit and wired into
`server.js`; see "Live vs. in-progress" below before assuming any of it is
earning players real GLDX today.

## What GLDX is

**GLDX is not a token STRATUM created or mints.** It's an existing external SPL
token — [[02-Token-Economy]]'s "xStock GLDX" — that the STRATUM mint already
interacts with via **StonkFun**: STRATUM is Token-2022 with a 1% transfer-fee
extension, and StonkFun pays that withheld 1% to STRATUM holders *as GLDX*. That
holder-reward mechanism is external to this codebase and already existed before
any of the modules below.

| Field | Value |
|---|---|
| GLDX mint | `Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re` (`Gldx.GLDX_MINT` in `src/gldx-yield.js`) |
| Decimals | 8 (`Gldx.DECIMALS`) — different from STRATUM's own 6, don't conflate the two |
| Who mints GLDX | Not STRATUM. This codebase never mints GLDX — `gldx-yield.js`'s own top comment is explicit: "it never mints GLDX" |
| Relation to STRATUM | STRATUM is the quote asset GLDX trades against on StonkFun; holding STRATUM already earns GLDX passively via the mint's own 1% tax |

**What this feature area adds:** a *second*, independent GLDX stream that pays
for *playing*, not just holding — the game's own fee-heavy sink economy earns
players a claimable GLDX balance, funded by swapping part of what players burn.

## The fee-heavy mechanism

Every STRATUM sink in the game (`src/token-sink.js`) splits spent STRATUM
80% burned / 20% treasury (`BURN_BPS = 8000`). This module is older than GLDX and
already covered lightly elsewhere — see `src/token-sink.js`'s own header comment
for the full rationale (why burn-heavy, why a spend-only-ever-adds economy needed
a drain at all).

GLDX-specific layer on top of that split (`src/gldx-yield.js`):

1. **Earning a claim.** Playing (harvest/craft/kill) credits `gldxPending` raw
   GLDX units via `Gldx.creditFor(action, multiplier, ctx)` — base rates
   `{ harvest: 100, craft: 150, kill: 150 }`, kill adds XP on top, multiplied by
   the player's *combined* reward-yield multiplier (colony × streak × holder ×
   builder × **tithe**, see below). This never touches real GLDX — it's a ledger
   promise (`token_ledger.gldx_pending`), same "queue now, pay when funded"
   pattern [[02-Token-Economy]] uses for STRATUM claims.
2. **Funding the claim.** When the on-chain sink runs (`STRATUM_SINK_ONCHAIN=1`,
   see below), of the treasury's 20% cut, `Gldx.earmarkOf()` sets aside **half**
   to later swap into real GLDX (`ChainAdapter.swapStratumForGldx`, gated behind
   `Gldx.MIN_SWAP = 25` whole STRATUM so dust never triggers a swap). The other
   half of the treasury cut stays as STRATUM.
3. **Moving pending → payable.** `fundGldxClaims()` (server.js) reads the
   treasury's *actual* real GLDX balance (`ChainAdapter.readMintBalance`) and
   calls `Gldx.allocate(rows, treasuryRaw)` — moves each player's `gldxPending`
   into `gldxPayable` pro-rata, capped by what the treasury can actually cover,
   dust going to the largest remaining claim. **A payable claim can never exceed
   real treasury GLDX** — same non-negotiable [[02-Token-Economy]] applies to
   STRATUM claims.
4. **Paying out.** `claim-gldx` (server.js `case 'claim-gldx'`) sends real GLDX
   from the treasury to the player's linked wallet via
   `ChainAdapter.transferRaw(..., Gldx.GLDX_MINT, ...)` — same "never mints,
   only pays what's actually payable" contract as a STRATUM claim.

**Two more sinks feed the same treasury cut, each with their own fee shape:**

| Sink | Entry/rate | Where it lands |
|---|---|---|
| **Tithes** (`src/tithes.js`) | 50,000 STRATUM fixed entry (100% treasury, not burn-split), then 100 STRATUM/week upkeep (normal 80/20 burn-split); while active, **+10% multiplier on every gldx-yield credit** (`Tithes.MULT = 1.10`) | Weekly sweep in `server.js` (`TITHE_SWEEP_MS`, hourly in prod); unaffordable upkeep lapses the tithe automatically, cancel is free |
| **Vault** (`src/vault.js`) | Stake pending STRATUM (1% entry fee), withdraw anytime (2.5% exit fee) — both fees to treasury | Weekly fixed GLDX emission pool (`Vault.WEEKLY_GLDX = 25000` raw units, env-tunable `STRATUM_VAULT_GLDX_WEEKLY`) split pro-rata across depositors straight into `gldxPending` — depth-of-stake reward, distinct from tithe's loyalty-boost |

Settler tithes are entered by talking to any of the three landing-camp NPCs
(Sable/Dray/Ilo) — see [[00-Overview]] — and both the tithe and vault UI are
part of the concurrent session's in-progress front-end work (see "Live vs.
in-progress" below).

## Live vs. in-progress (verify before trusting)

- **`src/gldx-yield.js` and `src/token-sink.js`** — committed (`git log --
  src/gldx-yield.js` / `src/token-sink.js`), wired into `server.js`, and their
  pure-logic tests pass (`node test-gldx-yield.js`, 17/17 PASS as of this
  page's last check). **No `test-gldx-yield-integration.js` exists** — the
  `claim-gldx` server path (funding, payout, the `Gldx.allocate` cap-by-real-
  balance logic in `fundGldxClaims()`) has no integration test as of this
  writing. That's a real gap, not a guess — verify with `ls test-gldx*`.
- **`src/tithes.js` and `src/vault.js`** — **untracked** (`git status` shows
  them as `??`), along with `test-tithes.js`, `test-tithes-integration.js`,
  `test-vault.js`, `test-vault-integration.js`. Uncommitted as of this page's
  last update — check `git status --short` before assuming they've landed.
  Despite being uncommitted, they are already fully wired into the *also-
  uncommitted* `server.js` diff (tithe start/cancel/upkeep-sweep, vault
  deposit/withdraw/weekly-emission-sweep, both HUD-integrated in `public/
  index.html` and `public/settlers.js`) — this is active, not scaffolding.
- **All four pure-logic test files pass** (`node test-tithes.js`,
  `node test-vault.js`) and **both integration suites pass end-to-end**
  against a real spawned server (`node test-tithes-integration.js`: 19/19,
  `node test-vault-integration.js`: 14/14) — verified directly, not assumed
  from reading the code. Re-run them yourself to reconfirm; they follow
  [[07-Testing]]'s isolation discipline (own ephemeral port, own SQLite file,
  never `data/world.db`/port 8090) but **do not** blank
  `STRATUM_CLAIM_SIGNER_KEY`/`STRATUM_TREASURY_KEY` in their spawned env —
  safe only because neither suite sets `STRATUM_SINK_ONCHAIN=1`, so
  `scheduleOnChainSink()` never actually calls chain-adapter regardless of
  what signer key a local `.env` supplies. If you extend either integration
  test to cover the on-chain path, blank those keys explicitly first.
- **The on-chain swap itself (`ChainAdapter.swapStratumForGldx`,
  `fundGldxClaims`) is gated behind `STRATUM_SINK_ONCHAIN`.** `.env.example`
  ships this as `STRATUM_SINK_ONCHAIN=1` with the comment "leave unset (or 0)
  for the ledger-only path used by tests" — meaning the *intent* is for
  production to run it live, but **this page cannot confirm Railway's actual
  production value** without checking the boot log or Railway variables
  directly (see [[06-Ops-Deploy]]). Don't assume live from the `.env.example`
  default alone.
- **`ambient-combat.js` is unrelated to GLDX** despite `Gldx.creditFor('kill', ...)`
  existing — kill credits currently come from `world.js`'s existing real-combat
  path. `ambient-combat.js` itself says in its own header "NOT WIRED YET" and
  has zero references anywhere outside its own file and its two test files
  (`test-ambient-combat.js`, `test-ambient-combat-integration.js`) — confirmed
  by `grep -r ambient-combat` across the repo. Don't conflate "Cozy pivot
  combat" with "GLDX kill credits"; they're separate systems that happen to
  share the word "kill".

## How a future session can verify or extend this

1. `git status --short` — confirm whether `src/tithes.js`/`src/vault.js` (and
   the matching `server.js`/`public/*` diff) have been committed yet, or are
   still another session's in-progress work. Don't stage/commit files you
   didn't write.
2. `node test-gldx-yield.js && node test-tithes.js && node test-vault.js` —
   pure math, no server needed, safe to run anytime.
3. `node test-tithes-integration.js && node test-vault-integration.js` — real
   server, isolated port/DB; clean up `data/test-*-integration.db*` after
   (see [[07-Testing]]'s "diagnostic artifacts" rule — these are gitignored
   but still shouldn't be left on disk).
4. To check real production GLDX numbers: [[02-Token-Economy]]'s "How to
   recheck" pattern applies identically — `BlockchainQuery.solana_get_balance`
   against the treasury address with `Gldx.GLDX_MINT` as the mint, or derive
   the ATA locally the same way STRATUM balance checks do.
5. If extending: a `test-gldx-yield-integration.js` covering `claim-gldx` end
   to end (funding via `fundGldxClaims()`, payout cap at real treasury
   balance, the "nothing ready" rejection path) is the most concrete gap this
   page found — nobody has proven that wiring against a real server yet.

## See also

- [[02-Token-Economy]] — the STRATUM mint/treasury/signer this system spends
  from and pays out of; GLDX claims share the exact same signer and the exact
  same "never mints, capped by real balance" discipline.
- [[03-Status]] — top-level live/gated summary, updated alongside this page.
- [[04-Roadmap]] — why this doesn't map cleanly onto either roadmap document's
  phases.
- [[08-Agent-Playbook]] — the parallel-sessions rule that applies directly to
  `src/tithes.js`/`src/vault.js`'s uncommitted state.
