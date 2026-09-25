# Land yield — spec (not yet built)

Holding STRATUM and claiming land are the two things holders and players each
do. Land yield fuses them: claimed tiles accrue a trickle scaled by wallet
holdings, so holders claim land and players hold bags.

## Numbers (compose with existing systems, do not retune them)

- Accrual: `tiles × Hstil drip` per hour, where drip = 1 gold-equivalent per
  10 tiles/hour base, multiplied by the holder tier multiplier
  (`holder-bonus.js`, already refreshed on wallet-link). No new multiplier.
- Collection: click own tile (or a COLLECT ALL button) — 10% of the accrued
  amount burns via `splitBurn` (same 80/20), rest to inventory/pending.
- Fallow: tiles unvisited 14+ days stop accruing until walked over (one tap,
  no cost). Track `lastVisit` per tile? Too heavy — track per player
  (`lastActiveAt` already in players.last): if the PLAYER is inactive 14d,
  all their tiles go fallow. One timestamp, same effect, no schema growth.
- Anti-whale: diminishing returns past 500 tiles (sqrt falloff), upkeep
  (2/tile/week, already live) already taxes mega-holdings.

## Storage

- `land_yield_owed(k, amount, updated)` single row per player (not per tile —
  1M tiles must never become 1M rows). Accrue lazily on view/collect:
  `owed += rate(tiles, holderMult) × elapsed`, same lazy pattern as idle.js.
- Collection pays out and zeroes. Burn goes through `applyBurnSplit` +
  `scheduleOnChainSink` like every sink.

## Why this composes

- Upkeep (live) already charges per tile — yield minus upkeep is the net,
  positive for actives, mildly positive for passives, zero for the long-dead
  (fallow). No new timers: piggyback the hourly weekly-processing sweep for
  fallow checks, lazy accrual on collect for the math.
- GLDX: collection is a reward action → flows through `applyCommerceReward`,
  which already credits `Gldx.creditFor`. No GLDX changes needed.

## Build order (when greenlit)

1. `src/land-yield.js` pure: rate(tiles, holderMult), fallow(playerLastActive),
   collectSplit. Unit test.
2. server: table, lazy accrual in ledgerOf-adjacent read, `collect-yield`
   handler, fallow gate. Integration test with backdated lastActive.
3. client: COLLECT ALL button + fallow tint on the world map. Guide paragraph.
