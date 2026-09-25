---
tags: [stratum, index]
---

# STRATUM Vault

This is an [Obsidian](https://obsidian.md) vault — open this `vault/` folder directly
in Obsidian, or just read the files as plain markdown. It's the guiding document for
STRATUM: any agent or session starting fresh on this project should read
[[08-Agent-Playbook]] first, then whatever page matches the task at hand.

**Why this exists.** STRATUM has run through many sessions — different models,
different agents, no shared memory between them. Each one had to re-derive context
from scratch: re-verify the mint, re-discover the Token-2022 gotcha, re-learn that
`server.js` has its own `.env` loader. This vault is where that kind of hard-won,
non-obvious knowledge gets written down ONCE so the next session (human or agent)
doesn't have to pay for it again. It is meant to be read *and* updated — a stale
vault is worse than no vault, so **update the relevant page in the same session/commit
that changes the thing it describes.**

## Map

| Page | What's in it |
|---|---|
| [[00-Overview]] | What STRATUM is, in one page — premise, the three sectors, the core loop |
| [[01-Architecture]] | The zero-dependency stack, key files, how the pieces fit |
| [[02-Token-Economy]] | The real Solana token: mint, treasury, signer, fees, claim/convert pipeline — the numbers that actually matter, and how to recheck them |
| [[03-Status]] | What's live in production RIGHT NOW vs. what's still gated off or missing — the single source of truth, supersedes anything else's memory of "current state" |
| [[04-Roadmap]] | Where the game design is headed — points at `ROADMAP.md` / `ROADMAP_COZY.md` at the repo root rather than duplicating them |
| [[05-Decisions-Log]] | Append-only log of major decisions and incidents, with dates and *why* — the "don't relearn what we already learned" page |
| [[06-Ops-Deploy]] | Railway project/service/environment IDs, env var reference, how to deploy/check logs/redeploy |
| [[07-Testing]] | Test suite conventions and the sharp edges (the `.env`-leak-into-tests lesson, isolated-DB discipline) |
| [[08-Agent-Playbook]] | Start here. Safety rules specific to this repo, what never to do without asking, how to orient fast |

## Scope

This vault is **STRATUM-only** — it does not cover the user's other projects (FOMMO,
Mossvale, Voxel Strike, etc.), each of which has its own repo and its own context.
That was a deliberate choice, not an oversight: ask before assuming this pattern
should extend elsewhere.

## Ground truth beats memory

Every fact in this vault was true when written, dated where it matters. Treasury
balances, deployment status, and "what's live" drift fast — this vault tells you
*where to look* to reverify (an RPC call, a Railway log, a git command), not just a
number to trust blindly. If something here contradicts what you observe in the code
or on-chain, **trust what you observe**, and fix this vault to match.
