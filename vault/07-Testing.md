---
tags: [stratum, testing]
---

# Testing

## Running tests

- `node run-tests.js` — the core protocol + restart-persistence suite (spawns real
  servers as child processes across phases A/B/C).
- `node test-<name>.js` — per-module pure-logic tests, no server needed.
- `node test-<name>-integration.js` — real server, real WebSocket client, own
  ephemeral port + own SQLite DB (never port 8090, never `data/world.db`).

There is no single "run everything" command that covers every `test-*.js` file in
the repo — `run-tests.js` is the curated core suite, not the full battery. To
actually run everything, iterate `test-*.js` yourself.

## The sharp edge: `server.js`'s own `.env` loader

**Any test that spawns `node server.js` inherits the local developer's `.env`
file contents, even if the test runner's own `process.env` doesn't have those
keys.** See [[05-Decisions-Log]]'s entry on this for the full mechanism. Practical
rule: if a test needs to assert "signer not configured" / "still a placeholder"
behavior, it must explicitly set `STRATUM_CLAIM_SIGNER_KEY: ''` (and the
`STRATUM_TREASURY_KEY` alias) in the child process's env — don't assume "the test
runner's shell doesn't have this var set" is enough.

## Isolation discipline

Always boot throwaway servers with an explicit non-default `STRATUM_DB=data/...`
path and a non-default `PORT` — never touch `data/world.db` or port 8090 (the
live defaults). Every existing integration test already follows this; match the
pattern rather than inventing a new one.

## Diagnostic artifacts

If you spin up a one-off diagnostic server (e.g. to check a boot-log line), clean
up its DB files (`data/diag-*.db*`) and kill the process when done — don't leave
throwaway servers running or throwaway DBs on disk.

## Safety around the signer key in tests

`test-rewards.js`'s `ca-describe-with-key-presence-only` test generates a
throwaway keypair on the spot for shape/presence checks — never use anything
resembling the real treasury key in a test, and never assert on or print secret
key bytes (only presence booleans and the safely-derived public address are ever
checked).
