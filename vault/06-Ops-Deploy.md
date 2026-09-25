---
tags: [stratum, ops, deploy, railway]
---

# Ops & Deploy

## Hosting

Railway. Deploys auto-trigger on push to `master`. Persistent volume backs `data/`
(`world.db`) — never delete or reset this against the live deploy; that erases
every player's claimed land permanently, violating the game's core promise.

| Field | Value |
|---|---|
| Project | `stratum` |
| Project ID | `e080cbef-6f0b-435c-b2d4-406722d70c63` |
| Service | `stratum` |
| Service ID | `05755ef1-2230-458d-bcd3-f2c5976e9b67` |
| Environment | `production` |
| Environment ID | `0d770c83-02b4-4a79-88a0-fbf239c2b723` |
| Public URL | https://planetstratum.fun |

## Checking status / logs

Via the Railway MCP tools (`get-status`, `get-logs`, `list-deployments` —
whichever Railway MCP server is connected in a given session; there have been at
least two different ones across sessions, with different auth) or the Railway CLI
directly if the MCP tool rejects object parameters (this has happened — `railway
whoami` / `railway status` / `railway service stratum` / `railway variables --set
"KEY=value" --skip-deploys` all work as a fallback).

The boot log's `[commerce] ...` lines are the fastest way to confirm the commerce
config landed correctly after any deploy — see [[02-Token-Economy]].

**Deploy times vary a lot** — observed anywhere from ~1.5 minutes to ~12 minutes
for the same kind of change, with no obvious pattern. Don't assume a deploy is
stuck just because it's slower than a previous one; check `list-deployments` /
`get-status` for actual state (`BUILDING` → `DEPLOYING` → `SUCCESS`/`FAILED`)
rather than timing out on wall-clock time alone.

## Env vars that matter (see `.env.example` for the full list)

| Var | What it does | Committed anywhere? |
|---|---|---|
| `STRATUM_TOKEN_MINT` | the real mint address | Yes — also a hardcoded source default |
| `STRATUM_TOKEN_DECIMALS` | `6` | Yes — also a hardcoded source default (fallback) |
| `STRATUM_TOKEN_PLACEHOLDER` | `false` in prod | Yes |
| `STRATUM_TREASURY_ADDRESS` | the funded treasury wallet | Yes — also a hardcoded source default |
| `STRATUM_CLAIM_SIGNER_KEY` (alias `STRATUM_TREASURY_KEY`) | the treasury's actual secret key | **NEVER committed, never logged, never pasted into chat with an AI agent.** Set directly in Railway's Variables tab or a local gitignored `.env` only. |
| `STRATUM_DB` | path to the SQLite file | Railway-specific (points at the mounted volume) |

## Local `.env`

Gitignored, contains a real signer key on this developer's machine. **`server.js`
reads this file directly off disk on every boot** — see [[05-Decisions-Log]] and
[[07-Testing]] for why this matters for anyone spawning `node server.js` locally,
including test harnesses. Never read or dump this file's full contents; if you
need to change one line, use a targeted `sed`/`Edit` on just that line.
