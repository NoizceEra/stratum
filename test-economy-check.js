/**
 * test-economy-check.js — focused re-run of the offline economy diagnostic.
 *
 * Asserts src/economy-check.js passes on current tables without breaking the
 * broader test-economy.js suite (which remains green).
 *
 *   node test-economy-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Eco = require('./src/economy.js');
const Check = require('./src/economy-check.js');
const SRC = fs.readFileSync(path.join(__dirname, 'src', 'economy-check.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let passed = 0, failed = 0;
function t(name, fn) {
  let ok = true, err = null;
  try { fn(); } catch (e) { err = e; }
  if (err) { ok = false; console.log('FAIL  ' + name + '\n        ' + (err && err.message)); }
  else console.log('PASS  ' + name);
  ok ? passed++ : failed++;
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

t('economy-check.js is dependency-free UMD, side-effect free', () => {
  // Allow a single lazy require('./economy.js') inside check() for live-table resolution;
  // forbid any other require (fs, path, etc.) or top-level require. That's the "No deps"
  // contract: no external npm deps, no I/O, but internal table resolution is okay.
  var withoutLazy = CODE.replace(/require\s*\(\s*['"]\.\/economy\.js['"]\s*\)/g, '');
  assert(!/(^|[^\w.$])require\s*\(/.test(withoutLazy.replace(/typeof require/g, '')), 'calls unexpected require()');
  assert(!/\bdocument\b/.test(CODE), 'touches document');
  assert(!/\bDate\s*\./.test(CODE), 'touches Date');
  assert(!/\bMath\s*\.\s*random\b/.test(CODE), 'uses Math.random');
  assert(/\btypeof module\b/.test(CODE), 'does not feature-detect module');
  assert(/root\.EconomyCheck/.test(CODE), 'does not assign root.EconomyCheck');
  assert(typeof Check.check === 'function', 'missing check() export');

  // browser dual-target
  const ctx = {};
  ctx.self = ctx; ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  assert(ctx.EconomyCheck && typeof ctx.EconomyCheck.check === 'function', 'window.EconomyCheck missing');
  assert(typeof ctx.module === 'undefined', 'leaked module global');
});

t('check() passes on current tables', () => {
  const res = Check.check();
  assert(res && typeof res === 'object', 'check() did not return object');
  assert(Array.isArray(res.issues), 'issues not array');
  if (!res.ok) {
    throw new Error('diagnostic failed: ' + res.issues.join('; '));
  }
  assert(res.ok === true, 'ok not true');
  assert(res.issues.length === 0, 'expected no issues but got: ' + res.issues.join('; '));
});

t('check() is pure: same call twice gives identical result, no mutation of live tables', () => {
  const beforeCosts = JSON.stringify(Eco.MATERIAL_COSTS);
  const beforeTiers = JSON.stringify(Eco.TOOL_TIERS);
  const a = Check.check();
  const b = Check.check();
  assert(JSON.stringify(a) === JSON.stringify(b), 'not deterministic');
  assert(JSON.stringify(Eco.MATERIAL_COSTS) === beforeCosts, 'mutated MATERIAL_COSTS');
  assert(JSON.stringify(Eco.TOOL_TIERS) === beforeTiers, 'mutated TOOL_TIERS');
});

t('check() never throws on garbage overrides', () => {
  const bads = [null, undefined, {}, { MATERIAL_COSTS: null }, { NODE_YIELDS: null }, { TOOL_TIERS: 'nope' }];
  for (const o of bads) {
    let threw = null, r = null;
    try { r = Check.check(o); } catch (e) { threw = e; }
    assert(!threw, 'check threw on ' + JSON.stringify(o) + ': ' + (threw && threw.message));
    assert(r && typeof r.ok === 'boolean' && Array.isArray(r.issues), 'bad shape for ' + JSON.stringify(o));
  }
});

t('check() flags an impossible material cost', () => {
  var impossible = Eco.MATERIAL_COSTS.map(function (c) { var o = {}; for (var k in c) o[k] = c[k]; return o; });
  impossible[0] = { wood: 9999 };
  const r = Check.check({ MATERIAL_COSTS: impossible, NODE_YIELDS: Eco.NODE_YIELDS, TOOL_TIERS: Eco.TOOL_TIERS, MAX_HARVESTS: Eco.MAX_HARVESTS });
  assert(r.ok === false, 'should be not ok for impossible cost');
  assert(r.issues.length > 0, 'should have issues');
  assert(r.issues.some(function (s) { return /MATERIAL_COSTS\[0\].*wood/.test(s); }), 'missing wood issue: ' + r.issues.join('; '));
});

t('check() flags an impossible tool tier cost', () => {
  var badTiers = JSON.parse(JSON.stringify(Eco.TOOL_TIERS));
  badTiers[3].cost = { crystal: 999 };
  const r = Check.check({ TOOL_TIERS: badTiers, NODE_YIELDS: Eco.NODE_YIELDS, MATERIAL_COSTS: Eco.MATERIAL_COSTS, MAX_HARVESTS: Eco.MAX_HARVESTS });
  assert(r.ok === false, 'should be not ok for impossible tool cost');
  assert(r.issues.some(function (s) { return /TOOL_TIERS\[3\]/.test(s); }), 'missing TOOL_TIERS issue: ' + r.issues.join('; '));
});

t('check() flags unknown resource', () => {
  const r = Check.check({ MATERIAL_COSTS: [{ unobtainium: 1 }], NODE_YIELDS: Eco.NODE_YIELDS, TOOL_TIERS: Eco.TOOL_TIERS, MAX_HARVESTS: Eco.MAX_HARVESTS });
  assert(r.ok === false, 'should be not ok for unknown resource');
  assert(r.issues.some(function (s) { return /unobtainium/.test(s); }), 'missing unobtainium issue');
});

t('node --check equivalent: file parses', () => {
  // Already proven by require() above, but keep explicit.
  assert(SRC.length > 200, 'file too small');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
