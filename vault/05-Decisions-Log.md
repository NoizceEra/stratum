---
tags: [stratum, decisions, incidents]
---

# Decisions Log

Append-only, newest first. Each entry: what happened, why, and what it means for
future work. The point of this page is that nobody should ever have to re-derive
one of these from scratch again.

---

## 2026-09-24 — Treasury address swapped to match the actual signer wallet

The treasury address baked into `token-config.js`'s `DEFAULTS` had **0 SOL and no
STRATUM associated token account at all** (verified on-chain). Separately, a real
signer key had just been added to `STRATUM_CLAIM_SIGNER_KEY` in Railway — but the
wallet that key actually controls turned out to be a *different* address than the
configured treasury, and it was already funded (~0.31 SOL, ~20.2M STRATUM).

**How the signer's real address was found without ever touching the raw key:**
`chain-adapter.js`'s `describe()` was extended to derive and return a
`signerAddress` field — a public key computed from the secret, which is safe to
surface by definition (it's the same address visible on any transaction that
wallet ever signs). This is the only value the module derives from the secret
outside the actual `settleClaim()` transfer. Logged in the boot log as
`[commerce] signer wallet <address>`.

**Then:** swapped `STRATUM_TREASURY_ADDRESS` everywhere — `token-config.js`
DEFAULTS, `.env.example`, README, Railway env — to the funded wallet. Confirmed via
boot log that treasury and signer lines now show the identical address.

**What this means going forward:** treasury and signer are two independent config
values that happen to point at the same wallet right now because someone made them
match deliberately. Nothing enforces they stay in sync. If either changes, recheck
both — see [[02-Token-Economy]].

---

## 2026-09-24 — `server.js` has its own `.env` loader; it reads the file every boot, independent of the parent process's environment

**The bug this caused:** two integration tests (`test-commerce-integration.js`,
`test-convert-integration.js`) started failing with `insufficient_treasury_balance`
instead of the expected `not_configured` — meaning the spawned test server was
somehow finding a real signer key that plain `process.env` checks in the same shell
swore wasn't there.

**Root cause:** `server.js` (near the top, `loadDotEnv()`) reads a local,
gitignored `.env` file straight off disk on every boot, and sets
`process.env[k] = v` for any key not already set — **completely independent of
what environment the process was spawned with.** A bare `node -e "console.log(process.env.X)"`
never triggers this (it's inside `server.js`'s own module code), but `node server.js`
— including when a test harness spawns it as a child process — always does. So a
developer's local `.env` (which has a real signer key on this machine) leaks into
every test server ever spawned via `node server.js`, regardless of what the test
runner's own `process.env` looked like.

**The fix:** both integration tests now explicitly set
`STRATUM_CLAIM_SIGNER_KEY: ''` and `STRATUM_TREASURY_KEY: ''` in the spawned
server's env, overriding the local file (the loader only fills in unset keys, so
an explicit empty string wins).

**What this means going forward:** any test that spawns `node server.js` and wants
to assert "not configured" behavior MUST explicitly blank the signer-key env vars,
or it may silently exercise real chain-adapter code against whatever real key
happens to be in the developer's local `.env`. See [[07-Testing]].

---

## 2026-09-24 — Real STRATUM mint wired in; two real bugs caught before they could bite

Verified the mint on-chain before treating it as real:
`EtCLoVVQ87RfiJELMvcHxf1JwcSP2iNAaL73uacPFaLU`, "Planet Stratum" / `STRATUM`,
~999.997M supply, mint+freeze authority both `null`. Two things about it meant this
was never a simple config swap:

1. **6 decimals, not 9.** Every default/fallback in the codebase assumed 9. An
   unnoticed mismatch would have encoded every real transfer amount 1000x too
   large. Fixed in `chain-adapter.js`, `token-config.js`, `.env.example`, README.
2. **Token-2022, not the legacy Token program.** `@solana/spl-token`'s helpers
   default to legacy silently. Fixed by reading the mint account's own `owner`
   field at settlement time and deriving ATAs / building instructions against
   whichever program actually owns it. Switched to `TransferChecked` (some
   Token-2022 extensions require it; it also catches a decimals mismatch at the
   instruction level as a second safety net). The mint also carries a **1%
   transfer-fee extension** — the token program's own config, not something
   STRATUM's code adds or controls.

Without this fix, every real claim would have failed (wrong program, wrong ATAs)
the instant a signer key was ever added — caught proactively via on-chain
verification, not via a live failure.

---

## 2026-09-24 — Display ticker renamed `STRM` → `STRATUM`

The on-chain mint's own metadata symbol is `STRATUM`, not `STRM` (the placeholder
ticker used before the real mint was wired in). Collision risk: `STRATUM` is also
the game's own name. User's explicit call: rename everywhere to match on-chain
exactly, rather than keep a locally-invented ticker. Applied via word-boundary-safe
bulk replace (`\bSTRM\b`) across UI, docs, NPC dialogue — deliberately left
internal-only identifiers alone where they're structurally independent ledger/env
keys (e.g. `STRATUM_TOKEN_SYMBOL` as an env var *name* prefix, or internal
accounting bucket keys), matching the earlier `silver`→`gold` resource-key
precedent (see `git log` for that one — a real data-model rename needed care and
explicit approval, this one didn't need to touch data-model keys at all).

---

## Earlier: `silver` → `gold` currency rename (see git log, commits around `c18d584`/`228db0e`)

The player-visible currency name was reverted from "silver" back to "gold" — the
underlying data model was *always* `gold` internally; only the display label had
drifted. Several stale "silver" references in comments/docs needed a follow-up
sweep (`c299aae`, `524543a`) after the main revert — a reminder that a rename
across a codebase this size rarely lands in one commit; budget for a cleanup pass.
