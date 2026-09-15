# STRATUM — Cozy Pivot (v0.5+)

A scope document for retuning STRATUM from "persistent land-scarcity MMO" toward
**lazy / idle / cozy**, with subtle combat, heavy crafting and gathering, and a light
social/economic layer — while keeping the two promises that make STRATUM STRATUM: the
land never resets, and there are no admins or moderation queue.

This document supersedes v0.5 "Society" and v0.6+ "Horizons" in ROADMAP.md. Everything
in v0.4 "Consequences" (drops, achievements, quests, geography) ships as-is and stays —
it's compatible with cozy, it just gets retuned, not replaced. Non-goals from ROADMAP.md
(no wipes, no admins, no chat, no trading without escrow) **still hold** — cozy doesn't
mean less disciplined, it means gentler stakes.

---

## Why pivot, and what actually changes

STRATUM's current identity is "land is scarce, contest it, no mercy" — wind-up combat,
pack aggro, half your resources spilled on death, an endgame framed as a claimed-%
race. That's a fine game. It is not a cozy one.

The pivot keeps the architecture (persistent authoritative server, terrain-as-pure-
function, zero dependencies, hardened WS transport) and keeps most of the *systems*
(crafting, tools, economy, achievements, leaderboard) — it changes the **stakes and
pacing** those systems run at, and adds one new pillar: **things happen for you while
you're not there.**

| | Today | Cozy pivot |
|---|---|---|
| Combat | Click to strike, dodge wind-ups, real danger | Ambient — proximity does the work, you can't really lose (on cozy maps) |
| Death | Half your raw resources spill on the ground | Softened to near-nothing on cozy maps; frontier maps keep real stakes |
| Progression | Grinding kills for XP | Gathering and crafting are the main XP source; combat is a side effect, not the loop |
| Time | Everything requires you present | Placed structures keep producing while you're logged off |
| Social | None (by design) | Shops, direct trade (escrowed), gifting, landmarks — still no open chat |

---

## The two-track world

Per the "keep both" decision: most of the world becomes **Sanctuary** — cozy rules.
One or two maps stay **Frontier** — today's ruleset, unchanged, for players who want
the harder game. This is a *ruleset flag per map*, not a fork: one server, one codebase,
one `T.MAPS[i].tone` field deciding which combat/death/pacing constants apply.

```
map 0  THE FIRST ACRE     -> Sanctuary  (was: gentle starter map — becomes the cozy home map)
map 1  ASHEN HOLLOW       -> Frontier   (was: hostile — stays hostile, unchanged)
map 2  THE SUNKEN SHELF   -> Sanctuary  (was: contested/scarce — becomes cozy, land scarcity retuned)
map 3+ (new)              -> either, author's choice per map going forward
```

`T.MAPS[i]` gains a `tone: 'sanctuary' | 'frontier'` field. Every system that currently
hard-codes "the" combat/death constants (`world.js`'s `COMBAT`, `PLAYER_SWING_MS`,
`src/drops.js`'s half-spill rule) reads them from a per-tone table instead. This is the
single structural change everything else hangs off, so it's Phase 0.

---

## Systems

### 1. Ambient combat (Sanctuary maps)

No click-to-attack, no wind-up dodge window, no player input beyond *being near* a
creature while you're doing something else (harvesting, walking, building). Design:

- A creature within a small radius of a player, on a slow tick (e.g. every 2–3s), takes
  a fixed tick of damage from *anyone nearby*, and deals a much-reduced tick of damage
  back. No crits, no misses, no telegraphs to read.
- Killing something still grants XP and loot — same `world.hunter()`/`grantLoot()`
  machinery underneath, just triggered by the ambient tick instead of `attack()`'s
  swing-and-cooldown path.
- HP loss from ambient combat is capped (e.g. never below 20% max HP) and regenerates
  fast when you step away — dying on a Sanctuary map should be rare enough to be a
  "huh, that happened" event, not a real threat.
- Pack aggro, leash-drag, and charge/wind-up AI (world.js's `stepMonster`) are disabled
  entirely on Sanctuary maps — monsters there just... exist, wander, and lose a slow
  trickle of HP when you're near.

Frontier maps keep `stepMonster`, wind-ups, crits, and real death stakes byte-for-byte
as they are today. This is why it's a *tone flag*, not a rewrite: the existing combat
code becomes the Frontier branch, and a new, much smaller ambient-combat module is the
Sanctuary branch.

### 2. Idle structures (new pillar)

Placed buildings that passively convert time into resources, whether you're online or
not — the classic idle-game hook, implemented the efficient way idle games actually do
it: **no continuous simulation.** A structure stores `lastCollectedAt`; yield is computed
lazily as `min(capacity, rate_per_ms * (now - lastCollectedAt))` at the moment someone
looks at it or collects it. Nothing ticks in the background for an offline structure —
zero server cost for players who are away, no matter how many structures exist.

- Structures are placed on your own claimed land (ties naturally into the existing land
  system — a structure needs an owned tile under it, so land ownership stays meaningful
  under cozy rules even without combat/scarcity driving it).
- A structure has a tier-gated recipe to build (same `ECO`-style cost-and-afford pattern
  as tools), a resource it produces, a rate, and a capacity. E.g.:
  - **Apiary** — herb → honey, slow, small capacity, tier 0
  - **Kiln** — ore → refined ore, tier 1
  - **Still** — wood + herb → tonic (a new consumable resource), tier 1
  - **Smoker** — wood → charcoal, feeds into later recipes, tier 2
- Collecting is a simple interaction (walk up, LMB or a dedicated key) that empties the
  accrued yield into your inventory and resets `lastCollectedAt` — same pattern as
  harvesting a node, but the "regrow timer" is continuous accrual instead of a single
  reset-on-deplete event.
- A structure that's full just stops accruing (capacity caps it) — no loss, no need to
  babysit it, which is the point.

### 3. Crafting & gathering, heavier lean

Gathering and crafting become the main XP and progression source, not a means to fund
combat gear. Concretely:

- Award a *small* amount of XP directly from harvesting and crafting (today only kills
  grant XP via `world.awardXp` — extend the call sites in `case 'harvest':` and
  `case 'craft':` in server.js to also award a small, tuned amount).
- Expand `ECO.RECIPES`/`ECO.ITEMS` well beyond weapons/armor: cozy-flavored crafted
  goods (furniture/decor placeable on your land, the idle structures above, tonics/food
  with mild buffs, gifts — see Society below).
- A gathering-focused tool ladder already exists (flint→steel yield/speed multipliers in
  `src/economy.js`) — this needs no new mechanic, just more reasons to want tier 3.
- Optional stretch: a "focus" bonus — staying in one area gathering for a while grants a
  small escalating yield bonus, encouraging settling in and pottering rather than
  optimizing a route. (Nice-to-have, not core.)

### 4. Society (retuned from the old v0.5, kept mostly intact)

Everything from the original ROADMAP.md v0.5 still applies, re-scoped for cozy:

- **Shops** — sell from your own claimed tiles, DB-escrowed, no direct scam surface.
  Unchanged from the original plan.
- **Direct trade** — new: an escrowed two-player trade/mail system (not in the original
  ROADMAP, added here because cozy games lean on *gifting*). Player A posts an offer
  addressed to player B (or open); it sits in an escrow table until B claims it or A
  cancels it; nothing is ever taken without both sides' consent captured server-side.
  This is the *only* new trust-sensitive system in this pivot — build it carefully,
  mirror the shop's escrow pattern exactly rather than inventing a second one.
- **Landmarks** — costly multi-material structures with world-wide effects. Unchanged
  from the original plan; fits cozy well (a lighthouse, a communal garden, a bell tower).
- **Titles as cosmetics** — already shipped via `src/achievements.js`. No new work,
  just more achievement entries themed around gathering/crafting/idle milestones instead
  of only combat ones.
- **Still no chat.** Cozy social without a chat box: an **emote wheel** (a fixed set of
  canned gestures/phrases, like "wave", "thanks!", "nice place!") and **gifting through
  the trade/mail system** cover "being nice to strangers" without opening a griefing
  surface. This is the cozy-game answer to the chat non-goal, not a reason to lift it.

### 5. Character customization (new — a big part of the game, not an afterthought)

Today a player's whole look is one auto-hashed hue (`T.hash2(key...) % 360`) fed into
two HSL shades (`hsl(hue,58%,62%)` body / `hsl(hue,48%,40%)` trim) inside
`drawAvatar(...)` in game.js — no player choice, no persistence beyond that one number.
The renderer is **fully procedural** (canvas shapes, no sprite sheets), which is the
right news here: customization is buildable as more *parameters* into the same draw
calls, not a new art pipeline.

- **Palette, player-chosen.** At the gate (today's name-entry screen) and revisitable
  later from a "wardrobe" panel, a player picks a body hue and a trim hue independently
  (today they're locked to the same hue at two lightnesses) from a curated set of good-
  looking combinations — not a raw 360° picker, which produces a lot of ugly results;
  curate ~24-32 palettes, cheap to hand-tune, easy to extend later.
- **Accessories/outfits as unlockable cosmetics**, layered onto the existing avatar
  shapes (a hat silhouette, a cloak/cape trim, a scarf) — additive draw calls, not a
  replacement geometry. This is where achievements pay off visually: extend
  `src/achievements.js`'s existing `titleFor(id)` pattern with a sibling
  `cosmeticFor(id)` so specific achievements unlock specific accessories, the same way
  they already unlock titles. Gathering/crafting/idle-themed achievements (Phase 3)
  unlocking gathering-flavored cosmetics (a "gardener's hat", "kiln-scorched apron")
  ties the whole loop together: play the way the game wants you to, look the part.
- **Persisted server-side**, not client-only — appearance is part of who you are on a
  shared server everyone sees, so it belongs next to `name`/`hue` in the `players` table
  (extend that row: `bodyHue`, `trimHue`, `accessory`), validated on every change the
  same way every other player-controlled field is (an accessory id must be one the
  player has actually unlocked — never trust the client's claim that it owns one).
- **A wardrobe UI**, not just the one-time gate picker: reuse the existing full-screen-
  overlay pattern (`#map`/`#nodes`/`#craft`) for a `#wardrobe` panel, unlocked cosmetics
  shown as swatches, locked ones shown greyed-out with their unlock condition as a
  tooltip (achievements.js already carries `desc` for exactly this).
- Deliberately **not** in scope for v1: separate sprite silhouettes per body type/build,
  animation-affecting cosmetics, or anything that would require new draw primitives
  beyond simple layered shapes. Keep the first pass entirely inside what `drawAvatar`
  already does well.

### 6. Light grouping (small, optional)

Not formal parties/guilds — just: players gathering the same node or fighting the same
ambient-combat creature within a small radius all get credit (XP + a share of drops),
so being near someone else is a small mutual benefit instead of a race. No UI, no
invite flow — proximity is the whole mechanic. Cheap to build, reinforces "cozy," and
was explicitly the kind of MMO-social-lite feature that fits STRATUM's no-admin
constraint (nothing to configure, nothing to grief).

---

## What does NOT change

- Land is still persistent, still owned absolutely, still never resets.
- No admins, no moderation queue, no wipes.
- No open/global chat.
- No PvP (this was never planned; still isn't).
- Zero npm dependencies. Ever.
- Server-authoritative validation on every inbound field, same hardening posture.
- One pure module per workstream, one integrator wires it into server.js/world.js/
  game.js — same discipline that shipped v0.4 cleanly. See the file scaffold below.

---

## File scaffold (mirrors the v0.4 pattern exactly)

| File | New/changed | Contract |
|---|---|---|
| `public/terrain.js` | changed | `T.MAPS[i].tone` field added; `T.COMBAT` becomes tone-keyed (`T.COMBAT.sanctuary` / `T.COMBAT.frontier`) |
| `src/idle.js` | **new** | Pure module: structure defs, accrual math (`yieldSince(struct, now)`), capacity clamp, collect. Zero deps, deterministic given `now` passed in — same contract as `drops.js`. Skeleton below. |
| `src/ambient-combat.js` | **new** | Pure module: the Sanctuary damage-tick math (who's in range, how much each tick deals, HP floor). world.js's `tick()` calls this on Sanctuary maps instead of `stepMonster`. Skeleton below. |
| `src/society.js` (or split into `src/shops.js` + `src/trade.js`) | **new** | Pure module(s): shop listing validation, escrow state transitions for both shops and player-to-player trade. Mirror `economy.js`'s `canAfford`/`applyCost` style exactly — this is the trust-sensitive one, keep it boring and exhaustively tested. |
| `src/economy.js` | changed | New structure recipes, decor/gift items, a `tonic`/consumable resource type if adopted |
| `src/achievements.js` | changed | New gathering/crafting/idle-themed entries (additive, existing 14 untouched); a `cosmeticFor(id)` sibling to the existing `titleFor(id)` |
| `src/customization.js` | **new** | Pure module: curated palette catalog, accessory catalog, which accessory ids an achievement unlocks, validate-a-requested-look-against-what's-unlocked. Mirror `achievements.js`'s frozen-table style. |
| `world.js` | changed | Branch `tick()`'s monster simulation on map tone; ambient-combat path for Sanctuary, existing `stepMonster` path for Frontier, unchanged |
| `server.js` | changed | New tables (`structures`, `trades`), new inbound message types (`build-structure`, `collect-structure`, `trade-offer`, `trade-accept`, `trade-cancel`, `emote`), tone-aware death/drop handling |
| `public/game.js` / `public/index.html` | changed | Structure placement UI (reuses the hotbar/build pattern), a collect prompt, an emote wheel, a trade panel (reuse the `#craft`/`#nodes` full-screen-overlay pattern) |

---

## Phased build order

Each phase is "pure module(s) + tests" first, wired by one integrator after — same
process that shipped v0.4's four workstreams cleanly in parallel.

**Phase 0 — Tone plumbing.** Add `tone` to `T.MAPS`, tone-key the combat/death
constants, no behavior change yet (both tones resolve to today's numbers). This is the
scaffolding everything else needs and should land alone, first, so nothing downstream
is guessing at where the flag lives.

**Phase 1 — Ambient combat.** `src/ambient-combat.js` + wiring, Sanctuary maps get the
soft combat model. Frontier untouched. Independently testable against the existing
protocol-suite style (real server, real ws client, assert damage/HP/XP behavior differs
by map tone).

**Phase 2 — Idle structures.** `src/idle.js` + wiring. Independently testable purely
on the accrual math (no server needed for the pure-module tests) plus one integration
suite (place → wait (scaled clock, same `STRATUM_RESPAWN_SCALE` trick already used for
node timers) → collect → confirm capacity clamp and restart-survival).

**Phase 3 — Heavier crafting/gathering.** Recipe/XP-source expansion in `economy.js` +
`achievements.js`. Lowest engineering risk, mostly data-table growth plus two new call
sites for XP-on-harvest/XP-on-craft.

**Phase 4 — Society.** Shops (already scoped in the original ROADMAP.md — build first,
lower risk), then trade/escrow (new, higher trust surface — build second, test hardest),
then the emote wheel (trivial, client-mostly). Landmarks last — highest cost, lowest
urgency, and benefits from structures (Phase 2) already existing as a pattern to extend.

**Phase 5 — Light grouping.** Smallest phase, layers on top of ambient combat + gathering
once both exist; proximity-credit sharing needs no new persistence, just a broadcast-time
check against nearby players.

---

## Open questions for later, not blocking scaffolding

- Exact ambient-combat numbers (tick interval, damage-per-tick, HP floor) — needs
  playtesting, not a spec decision.
- Whether idle structures need an upkeep cost (a trickle resource drain) to avoid
  every player eventually blanketing their land in producers — leaning **no** (violates
  the "cozy = no punishing systems" spirit) but worth a real decision before Phase 2 ships.
- Whether trade offers expire (TTL, like `src/drops.js`'s cache TTL) or sit forever —
  leaning **yes, generous TTL** (e.g. 7 days) to avoid unbounded DB growth from abandoned
  offers, mirroring the drop-cache precedent.
