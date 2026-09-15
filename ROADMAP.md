# STRATUM — Roadmap

One finite world per map. The land never resets; the provisions always do.
Everything below must survive contact with those two rules: no wipes, no admins,
no moderation queue, no pay-to-win, no global chat (grief vector with no mods).

## Where we are — v0.3 "Overhaul" (LIVE, commit d3d797f)

Hardened server (rate limits, frame caps, slowloris defense). 13 monster species
with real AI (aggro/chase/leash, wind-ups, crits, XP, levels, loot). Autotiled
graphics with combat feel. Full economy: build costs, tool tiers, 8 gear recipes,
crafting UI, procedural SFX. 6 suites green (economy 24, hardening 41, combat 88,
integration 22, regression full).

## v0.4 "Consequences" (IN PROGRESS)

The loop works but nothing is at stake and nobody is guided. Four workstreams,
each a pure module + tests, wired by one integrator (no shared-file edits):

| # | Module | Engagement job |
|---|--------|----------------|
| 1 | `src/drops.js` — death drops half your raw resources where you died | short-term: every fight has stakes; corpse-runs |
| 2 | `src/achievements.js` — ~14 achievements + titles | mid-term: reasons to try everything, status that persists |
| 3 | terrain geography rebalance | short-term: the first 10 minutes teach harvest instead of wandering (no trees near spawn today — probed) |
| 4 | `public/quests.js` — client-side first-session quests | short-term: claim → harvest → kill → craft → upgrade → travel → level |

Plus: `/api/leaderboard` (land, kills, level — read-only, from existing tables).

## v0.5 "Society" (NEXT)

- Player shops: sell from your own claimed tiles (escrow in DB, no direct trade = no scamming).
- Shared landmarks: costly multi-material structures with server-wide effects
  (e.g. a lighthouse that reveals its map's density grid to everyone).
- Titles as cosmetics: hue/banner unlocks from achievements.

## v0.6+ "Horizons" (LATER)

- Map #4+ as seasons: old maps never touched, new frontier on a schedule.
- Monster surges: timed events on the volatile layer (resets are free by design).
- PWA packaging for install-to-homescreen; permanent hosting off the desktop.

## Engagement frame (why this order)

- **Session (minutes):** harvest → craft → kill loop with sound, quests pointing
  at the next thing, death risk making fights real.
- **Weeks:** tool/gear ladder, achievements, leaderboard position, shop income.
- **Months:** land empire, season frontiers, titles nobody else has.

## Non-goals (say no fast)

Land decay/upkeep (violates the core promise), wipes, admins, chat, trading
without escrow, anything that needs an app store.
