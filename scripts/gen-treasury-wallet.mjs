/**
 * One-shot treasury wallet generator. Uses ethers via npx resolution if needed.
 * Prints JSON { address, privateKey } to stdout. Never writes to disk itself.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);

function viaEthers() {
  try {
    const { Wallet } = require('ethers');
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey, method: 'ethers' };
  } catch {
    return null;
  }
}

function viaNpx() {
  const script = [
    "const {Wallet}=require('ethers');",
    'const w=Wallet.createRandom();',
    "process.stdout.write(JSON.stringify({address:w.address,privateKey:w.privateKey,method:'npx-ethers'}));"
  ].join('');
  const r = spawnSync('npx', ['--yes', 'ethers@6.13.5', '-e', script], {
    encoding: 'utf8',
    shell: true,
    cwd: path.dirname(fileURLToPath(import.meta.url))
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || 'npx ethers failed\n');
    process.exit(1);
  }
  const line = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .reverse().find((l) => l.startsWith('{'));
  if (!line) {
    process.stderr.write('no JSON from npx ethers\n' + (r.stdout || ''));
    process.exit(1);
  }
  return JSON.parse(line);
}

const out = viaEthers() || viaNpx();
process.stdout.write(JSON.stringify(out) + '\n');
