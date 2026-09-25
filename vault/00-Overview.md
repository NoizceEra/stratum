---
tags: [stratum, overview]
---

# What STRATUM is

A zero-npm-dependency, persistent-world multiplayer colony-sim, live at
[planetstratum.fun](https://planetstratum.fun). One shared world per map, real-time
over WebSocket, server-authoritative, no admins, no wipes, no moderation queue.

**The premise:** "Earth's gold is gone." Colonists land on Stratum to mine, build,
and survive — and everything they claim or build stays exactly as they left it,
forever. No resets, ever. Land is a finite resource and the HUD shows exactly how
much of the world is claimed.

**Two layers, two rules:**
- **Persistent** — land you claim and build on. Never resets, never overwritten.
- **Volatile** — ore, timber, crystal, beasts. Regrows on timers. The planet
  provides; it isn't a quarry you empty.

## Three sectors

| Map | Name | Character |
|---|---|---|
| 0 | THE FIRST ACRE | Verdant landing zone — every colonist's first foothold, camp with 3 NPCs (Sable, Dray, Ilo) walking new arrivals through the first week |
| 1 | ASHEN HOLLOW | Volcanic mining district — heavy ore, bring your own timber |
| 2 | THE SUNKEN SHELF | Flooded coastal claim — solid ground is scarce and contested |

## Core loop

Mine → craft → build → claim land, with monsters to fight and drops on death.
Rewards pay in two currencies simultaneously: soft in-game **gold** and hard
**STRATUM** (a real Solana SPL token) — see [[02-Token-Economy]]. "No purchase
necessary" — both are earned by playing only; there is no way to buy gold or
STRATUM with real money anywhere in this codebase (a deliberate, currently-enforced
constraint — see [[03-Status]] before assuming that's still true).

## Who plays it, and how they get in

No login, no password, no email. A guest identity is created client-side at the
gate screen (pick an avatar color, type a name) — see [[01-Architecture]] for how
that identity is actually keyed server-side.

## Where to go next

- Technical shape of the codebase → [[01-Architecture]]
- The real crypto economy, numbers as of last check → [[02-Token-Economy]]
- What's actually live right now vs. still gated → [[03-Status]]
- Where the game design is headed → [[04-Roadmap]]
