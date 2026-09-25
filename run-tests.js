/**
 * run-tests.js — self-contained test runner.
 *
 * This host reaps Hermes-launched background daemons after ~30s, so every server here is
 * spawned as a CHILD of this script: everything lives inside one foreground call and
 * nothing has to survive outside it.
 *
 * Three phases:
 *   A  protocol suite       (throwaway DB, respawn clocks scaled down so resets are observable)
 *   B  restart setup        (throwaway DB, REAL respawn clocks, claim land + deplete a node)
 *   C  restart verify       (SAME DB, land must be intact and the node still regrowing)
 *
 *   node run-tests.js
 */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CWD = __dirname;
const TESTDB = path.join(CWD, 'data', 'test.db');

function wipe(db) { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + s); } catch (e) {} } }

function startServer(port, db, respawnScale) {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PORT: String(port), STRATUM_DB: db, STRATUM_RESPAWN_SCALE: String(respawnScale), STRATUM_SINK_ONCHAIN: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
  srv.stderr.on('data', d => process.stdout.write('[srv:ERR] ' + d));
  return srv;
}

function waitReady(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stats' }, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (++tries > 90) return reject(new Error('server never came up on :' + port));
        setTimeout(tick, 150);
      });
    };
    tick();
  });
}

// Grab an unused port so two suites (or two agents) never collide on a fixed one.
function freePort() {
  return new Promise(res => {
    const s = require('node:net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function runChild(args, port) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, {
      cwd: CWD, env: { ...process.env, PORT: String(port) }, stdio: 'inherit'
    });
    c.on('exit', code => resolve(code === null ? 2 : code));
  });
}

async function phase(label, port, db, scale, args, fresh) {
  if (fresh) wipe(db);
  const srv = startServer(port, db, scale);
  let code = 2;
  try {
    await waitReady(port);
    console.log('\n[run] ' + label + ' — server ready on :' + port);
    code = await runChild(args, port);
  } catch (e) {
    console.error('[run] ' + e.message);
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 500));
  }
  return code;
}

(async function () {
  let bad = 0;

  // A: protocol suite, fast respawn clocks
  if (await phase('PHASE A — protocol suite', await freePort(), TESTDB, 0.02, ['test.js'], true) !== 0) bad++;

  // B/C: restart persistence with REAL timers, same DB across the restart
  const restartDb = path.join(CWD, 'data', 'restart.db');
  if (await phase('PHASE B — restart setup', await freePort(), restartDb, 1, ['test-restart.js', 'setup'], true) !== 0) bad++;
  if (await phase('PHASE C — restart verify', await freePort(), restartDb, 1, ['test-restart.js', 'verify'], false) !== 0) bad++;

  console.log('\n' + (bad === 0 ? '=== SUITE GREEN ===' : '=== ' + bad + ' PHASE(S) FAILED ===') + '\n');
  process.exit(bad === 0 ? 0 : 1);
})();
