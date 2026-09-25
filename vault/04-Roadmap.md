---
tags: [stratum, roadmap]
---

# Roadmap

The actual roadmap documents live at the repo root, not duplicated here (duplication
is how vaults rot — one source, this page just orients you):

- **`ROADMAP.md`** — the original plan (v0.3 "Overhaul" through v0.6+ "Horizons").
  Its own v0.5/v0.6 sections are **superseded** by `ROADMAP_COZY.md` below; v0.4
  "Consequences" still stands and shipped.
- **`ROADMAP_COZY.md`** — the current plan. A deliberate pivot from "land-scarcity
  MMO, real combat stakes" toward lazy/idle/cozy: ambient combat, idle structures
  that produce while you're offline, heavier crafting/gathering as the XP source,
  escrowed player trade, character customization, light grouping. Explicitly keeps
  the non-negotiables: land never resets, no admins, no wipes, no open chat.

**Check [[03-Status]]'s "in-flight work" note before trusting either document's
phase markers** — several cozy-pivot modules (`idle.js`, `ambient-combat.js`,
`customization.js`) already exist in `src/`, meaning implementation is ahead of
what a quick read of the roadmap doc alone would suggest.

## Scope neither roadmap document anticipated: GLDX / passive rewards

The fee-heavy GLDX passive-rewards system (`src/gldx-yield.js`, `src/token-sink.js`,
`src/tithes.js`, `src/vault.js` — see [[09-GLDX-Passive-Rewards]] for full detail)
is **not mentioned in either `ROADMAP.md` or `ROADMAP_COZY.md`** (checked directly,
`grep -i gldx` on both files returns nothing). It doesn't fit as a sub-phase of the
Cozy pivot either — it's a parallel, independent economy feature (a second
currency plus two new sinks) built by a concurrent session, not a step toward
ambient combat / idle structures / customization. Don't force it into an existing
phase marker; if either ROADMAP document gets a real update pass, this needs its
own new section rather than a retrofit into v0.5/v0.6 or a Cozy-pivot phase.

## Non-goals (both documents agree, don't relitigate these without a real reason)

Land decay/upkeep, wipes, admins, moderation queue, open/global chat, trading
without escrow, PvP, anything needing an app store. These are load-bearing
promises to players, not arbitrary scope cuts.

## Separate from game-design roadmap: infrastructure/economy hardening

Not tracked in either ROADMAP file, but real near-term work based on
[[03-Status]]'s honest gaps:
- Legal review of real-money play-to-earn mechanics before scale.
- Monitoring/alerting on treasury balance (claims will start failing again if it
  drains and nobody's watching — see [[02-Token-Economy]]).
- Whatever the anti-cheat gap (patient bots under threshold) needs next, if abuse
  is observed in practice rather than theorized.
