/**
 * _hudcheck.js — the HUD contract, checked mechanically.
 *
 * game.js talks to the page with document.getElementById('X'). index.html owns those
 * elements. If an id is renamed on one side only, the client dies at the first HUD
 * update with "Cannot set properties of null" — an error nobody sees until they are
 * already in a fight. This script closes that gap: every id game.js asks for must exist
 * in the HTML, and the fragile mobile-layout invariants must still be in place.
 *
 *   node public/_hudcheck.js        (run from the repo root or from public/)
 *
 * Exits 0 when the contract holds, 1 with a list of what is missing otherwise.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const root = fs.existsSync(path.join(here, 'game.js')) ? here : path.join(here, 'public');
const gamePath = path.join(root, 'game.js');
const htmlPath = path.join(root, 'index.html');

function readOrDie(p) {
  try { return fs.readFileSync(p, 'utf8'); }
  catch (e) { console.error('FAIL — cannot read ' + p + ': ' + e.message); process.exit(1); }
}

const game = readOrDie(gamePath);
const html = readOrDie(htmlPath);

// ---- every document.getElementById('X') literal in game.js ----------------
const wanted = new Set();
const refRe = /document\s*\.\s*getElementById\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
let m;
while ((m = refRe.exec(game)) !== null) wanted.add(m[2]);

// variable indirection (getElementById(id) inside a helper) is resolved by hand:
const helperIds = [];
const dynRe = /document\s*\.\s*getElementById\s*\(\s*(?!['"])[A-Za-z_$][\w$]*\s*\)/g;
while ((m = dynRe.exec(game)) !== null) helperIds.push(m[0]);

// ---- every id attribute declared in index.html ---------------------------
const present = new Set();
const idRe = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
while ((m = idRe.exec(html)) !== null) present.add(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));

const dupRe = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const seen = new Set(), dups = new Set();
while ((m = dupRe.exec(html)) !== null) {
  const id = m[1] !== undefined ? m[1] : m[2];
  if (seen.has(id)) dups.add(id); else seen.add(id);
}

// parcel modal inputs are injected via innerHTML, not static HTML — allowlist them
const DYNAMIC_ALLOW = new Set(['parcel-cancel-modal', 'parcel-confirm-list', 'parcel-price-item', 'parcel-price-qty']);
const missing = [...wanted].filter(id => !present.has(id) && !DYNAMIC_ALLOW.has(id)).sort();
const bad = [];

if (missing.length) bad.push('ids referenced by game.js but absent from index.html: ' + missing.join(', '));
if (dups.size) bad.push('duplicate id attributes in index.html: ' + [...dups].sort().join(', '));

// ---- mobile layout invariants (expensive to get right, cheap to assert) ---
function need(label, ok, detail) { if (!ok) bad.push(label + ' — ' + detail); }

need('canvas viewport', /viewport-fit=cover/.test(html), '<meta name="viewport" ... viewport-fit=cover> missing');
need('fixed HUD', /\.panel\s*\{[^}]*position\s*:\s*fixed/.test(html), '.panel must be position:fixed (absolute slides under visual-viewport panning)');
need('no absolute HUD panel', !/#hud-(tl|tr|bl|br)\s*\{[^}]*position\s*:\s*absolute/.test(html), '#hud-* must not be position:absolute');
for (const side of ['top', 'bottom', 'left', 'right']) {
  need('safe-area ' + side, html.indexOf('env(safe-area-inset-' + side + ')') >= 0, 'env(safe-area-inset-' + side + ') missing');
}
need('short-screen pad row', /@media\s*\(max-height:\s*460px\)/.test(html), '@media (max-height:460px) rule missing');
need('joystick', /id="stick"/.test(html) && /id="knob"/.test(html), '#stick / #knob missing');
need('touch pad', /id="pbtns"/.test(html), '#pbtns missing');
need('pixelated', /imageSmoothingEnabled\s*=\s*false/.test(game), 'game.js must keep imageSmoothingEnabled = false');
need('visual viewport sizing', /window\.visualViewport/.test(game), 'game.js must size the canvas from window.visualViewport');
need('camera snap on resize', /S\.cam\.x\s*=\s*S\.x/.test(game), 'resize() must snap (not lerp) the camera');
for (const ev of ['touchstart', 'touchmove', 'touchend']) {
  need('canvas ' + ev, game.indexOf("cv.addEventListener('" + ev + "'") >= 0, "canvas '" + ev + "' handler missing");
}
need('compact hud-tr collapse', /@media\s*\(max-width:\s*480px\)/.test(html) && /#hud-tr\s*\{\s*display\s*:\s*none/.test(html), '@media (max-width:480px) must hide #hud-tr');
need('compact line in hud-tl', /id="h-compact"/.test(html), '#h-compact missing (compact claims/quota for <480px)');
need('hotbar 44px tap target', /#hotbar\s*\.slot[^}]*44px/.test(html), 'body.touch #hotbar .slot must be >=44px tap target');
need('stick safe-area', /#stick[^}]*env\(safe-area-inset-bottom\)/.test(html), '#stick must use env(safe-area-inset-bottom)');

if (bad.length) {
  console.error('HUDCHECK FAILED (' + bad.length + ')');
  for (const b of bad) console.error('  · ' + b);
  if (missing.length) console.error('\nMISSING IDS: ' + missing.join(' '));
  process.exit(1);
}

console.log('HUDCHECK OK — ' + wanted.size + ' ids referenced by game.js all exist in index.html'
  + ' (' + present.size + ' ids declared, ' + helperIds.length + ' indirect lookups),'
  + ' mobile layout invariants intact');
