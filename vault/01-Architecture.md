---
tags: [stratum, architecture]
---

# Architecture

**Zero npm dependencies for the game itself** — `node:http`, `node:sqlite`, and a
hand-rolled RFC 6455 WebSocket implementation. The Solana commerce path
(`@solana/web3.js` + `@solana/spl-token`) is the one deliberate, scoped exception —
see [[02-Token-Economy]] for why hand-rolling signing was rejected there.

## Core files

```
server.js              transport, sessions, land ownership, players, WS message routing
world.js                the VOLATILE layer: resource nodes, monsters, respawn timers
public/terrain.js       deterministic world generation — shared verbatim by client and server
public/game.js          client: renderer, input, netcode
public/index.html       shell, HUD, gate screen, travel panel
public/guide.html       player-facing Colonist's Guide (/guide.html)
public/landing.html     marketing landing page (/), links to /play
data/world.db           the world. Delete it (+ -wal/-shm) to reset everything — never do this against the live deploy.
```

**Two design invariants worth internalizing before touching anything:**

1. **Base terrain is never stored.** It's a pure function of `(map, x, y)` in
   `public/terrain.js`, the *same file* the server runs. Client and server can
   never disagree about the world because there's only one implementation. Only
   player edits (claims, placements) travel over the wire as sparse deltas.
2. **The server trusts nothing from the client.** Every placement is revalidated
   server-side (reach, bounds, ownership, material, energy). Movement is
   rate-limited. Respawn timers are the server's, not the client's.

## `src/` — pure, tested modules

Each is a standalone module with its own test file (`test-<name>.js` and often
`test-<name>-integration.js`), wired into `server.js`/`world.js` by one integrator
rather than edited in place by every feature — this discipline is why the test
suite stays parallel-friendly. Non-exhaustive, current as of last vault update —
run `ls src/` for ground truth:

`achievements` `ambient-combat` `anti-cheat` `builder-bonus` `chain-adapter`
`colony-milestone` `crafting` `customization` `drops` `economy` `economy-check`
`gldx-yield` `harvesting` `holder-bonus` `idle` `mining-streak` `parcels` `payout`
`rewards` `shops` `token-config` `token-sink` `trade` `tithes` `wallet-proof`

`chain-adapter.js` and `token-config.js` are the commerce-critical pair — see
[[02-Token-Economy]] before touching either. `ambient-combat.js`, `customization.js`,
and `idle.js` existing means the [[04-Roadmap]] "Cozy pivot" is already partway
implemented, not just planned — check their git history/tests before assuming
they're stubs. `tithes.js` and `gldx-yield.js` were added by a concurrent session
and aren't yet described here in detail — read them directly rather than trusting
a summary this vault doesn't have yet.

## Testing entry points

`test.js` / `run-tests.js` — the core protocol + restart-persistence suite (phases
A/B/C, each spawning a real server as a child process). Every `src/` module has its
own `test-<name>.js` (pure logic) and often `test-<name>-integration.js` (real
server, real WebSocket client). See [[07-Testing]] before running or writing tests
— there's a real footgun in how the server loads `.env`.

## Design system (visual)

Warm-dark, monospace, one gold accent — no rounded corners, no gradient fills.
Tokens (from `public/index.html`'s `:root` and mirrored in `public/landing.html`):

```
--ink   #e8e6df   body text
--dim   #8b8578   secondary/dim text
--gold  #c9a55c   the one accent — buttons, headings, links
--bg    #0b0c10   base background
--panel rgba(10,11,15,.82)   translucent panel fill, backdrop-blur
--rule  rgba(201,165,92,.28)  gold-tinted hairline borders
```

`/play` (the game) and `/` (landing) intentionally share this exact system — they
read as one product, not a glossy marketing site handing off to a plain app.
