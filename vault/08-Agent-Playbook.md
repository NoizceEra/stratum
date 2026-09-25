---
tags: [stratum, playbook, agent-guide]
---

# Agent Playbook — read this first

If you're starting a fresh session on STRATUM, read this page before touching
anything. It's the shortest path to not repeating a mistake someone already made.

## Orient fast

1. [[03-Status]] — what's actually live right now. Trust this over your own
   training-time knowledge or another session's stale summary.
2. `git status --short --branch` and `git fetch origin` — **multiple sessions can
   be editing this repo at the same time** (observed directly — see
   [[03-Status]]'s "in-flight work" note). Never assume a clean working tree.
   Never run a destructive git command (`reset --hard`, `checkout .`, force-push)
   without first checking whether uncommitted changes belong to someone else's
   in-progress work.
3. `git log --oneline -20` — what actually shipped recently, which may be ahead
   of what any doc (including this vault) says.

## Hard rules — real money is involved now

- **Never paste, read, or ask for `STRATUM_CLAIM_SIGNER_KEY` / the treasury
  private key.** If a user offers it, tell them exactly where it goes (Railway's
  Variables tab, or a local gitignored `.env`) and decline to receive it, even if
  they insist. This has come up before — the correct answer hasn't changed.
- **Never trigger a real "claim" action** (in-game button, or programmatically)
  as part of testing, demoing, or recording gameplay footage. As of 2026-09-24
  this is LIVE and moves real crypto irreversibly — see [[02-Token-Economy]]. If
  you need to demo the economy UI, cover wallet-linking, viewing balances, and the
  (safe, off-chain) gold→STRATUM convert — never claim.
- **Never delete or reset `data/world.db`** on the live deploy, or run any
  operation that could. Player land is permanent by design; that promise is the
  whole premise of the game.
- **When a test needs "signer not configured" behavior, explicitly blank
  `STRATUM_CLAIM_SIGNER_KEY`/`STRATUM_TREASURY_KEY` in that test's env.** See
  [[07-Testing]] — `server.js`'s own `.env` loader will otherwise leak a real key
  into any spawned test server regardless of the test runner's own shell env.

## Before committing/pushing

- Check for concurrent-session changes (`git fetch origin && git status --short
  --branch`) — this repo has had multiple sessions committing to it concurrently.
- Run the tests relevant to whatever you changed before pushing, not just
  `run-tests.js` (which doesn't cover every `test-*.js` file — see [[07-Testing]]).
- If a deploy is triggered, verify the boot log afterward rather than assuming
  success from a green push.

## Keeping this vault honest

This vault is only useful if it's true. If you learn something non-obvious that
cost you real time to figure out — a gotcha, a root cause, a "why is it built this
way" — add it to [[05-Decisions-Log]] before you forget it. If you notice
something here that's now wrong, fix it in the same session, don't leave it for
someone else to get burned by.
