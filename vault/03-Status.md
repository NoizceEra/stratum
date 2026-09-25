---
tags: [stratum, status]
---

# Status — what's actually true right now

This page supersedes any other document's (including README.md's) memory of
"current state" if they disagree — update this page whenever reality changes, and
fix the stale doc too if you find one. Last updated 2026-09-25.

## Live in production

- **The game itself**: [planetstratum.fun](https://planetstratum.fun), real players,
  real persistent land, three maps, full core loop. See [[06-Ops-Deploy]].
- **The real STRATUM mint**, wired everywhere (game, landing page, guide, docs) —
  see [[02-Token-Economy]].
- **On-chain settlement is LIVE** (since 2026-09-24) — signer configured, treasury
  funded and matched to the signer's actual wallet. A real claim now actually pays
  out. This is a recent, significant state change — don't trust an older memory
  (yours or another session's) that says claims only queue.
- **Display ticker is `STRATUM` everywhere** (renamed from the earlier `STRM`
  placeholder to match the mint's own on-chain metadata) — UI, docs, NPC dialogue,
  landing/guide pages all consistent as of 2026-09-24.
- **`src/gldx-yield.js` and `src/token-sink.js` (the GLDX fee-heavy passive-
  rewards system) are committed and wired into `server.js`.** Full detail in
  [[09-GLDX-Passive-Rewards]] — a second currency (GLDX, an external SPL token,
  not minted by STRATUM) that players earn a claimable balance of by playing,
  funded by swapping half of what sinks send to the treasury. Whether the
  on-chain swap actually fires in production depends on `STRATUM_SINK_ONCHAIN`
  — verify the Railway value, don't assume from `.env.example`'s default.

## Known gaps (honest, from README's own Status section — verify it's still current)

- No fiat/crypto on-ramp to buy gold or STRATUM — earned by playing only, by design.
- Anti-cheat covers economic abuse (rate/rhythm/IP-density on reward actions) but
  not device fingerprinting or persistent suspicion history — a patient bot under
  the thresholds isn't caught.
- Real-money play-to-earn is a regulated space in most jurisdictions — this hasn't
  had legal review as of last check.

## In-flight work (observed, not authored by this vault's writer — verify directly with `git status --short`, this drifts fast)

As of this page's last update, a concurrent session had uncommitted local changes
to `server.js` / `public/game.js` / `public/guide.html` / `public/index.html` /
`public/settlers.js` / `test-settlers.js`, plus new **untracked** `src/tithes.js`
and `src/vault.js` (each with pure + integration tests), and its own independent
[HyperFrames](https://github.com) trailer build under `trailers/` at the repo root
(unrelated to any trailer work referenced elsewhere). **Multiple sessions can be
live on this repo at once** — see [[08-Agent-Playbook]]'s parallel-sessions rule
before assuming the working tree is clean or that you're the only one editing.

Despite being uncommitted, `src/tithes.js`/`src/vault.js` are fully wired end to
end (server message handlers, a weekly upkeep/emission sweep, and HUD/NPC-dialogue
UI in the also-uncommitted `public/` diff) and their pure-logic AND integration
tests all pass as of this page's last check — see [[09-GLDX-Passive-Rewards]] for
the full picture and exactly what commands to rerun to reconfirm. This is not a
scaffold; treat it as real, tested, pre-commit work.

The [[04-Roadmap]]'s "Cozy pivot" (`ROADMAP_COZY.md`) is partway implemented —
`src/idle.js`, `src/ambient-combat.js`, `src/customization.js` all exist in `src/`
already, meaning at least some of Phases 0-3 have landed. Don't assume the roadmap
document's phase markers reflect actual completion — check `git log` and the
files themselves.

## Verifying any "is X live" question yourself

1. Boot log: Railway → service `stratum` → latest deployment → deploy logs → look
   for `[commerce] ...` lines (mint/treasury/signer readiness) and whatever
   feature-specific log lines that system prints on boot.
2. Git log: `git log --oneline -20` for what's actually shipped, not just planned.
3. `git status --short --branch` before touching anything — see if someone else is
   mid-edit (see [[08-Agent-Playbook]]).
4. For money-real claims specifically: [[02-Token-Economy]]'s "How to recheck".
