/**
 * STRATUM — browser client.
 *
 * The base world is regenerated locally from each map's seed (free, no network). Only
 * player edits and volatile entities travel over the wire.
 *
 * RENDERING
 *   Every material is painted once into a 16x16 pixel array (noise + per-material
 *   detail: strata, blades, ripples, brick courses, ore veins...). A composite cache then
 *   bakes "tile variant + autotiled edges + corner occlusion" into a tiny 16x16 canvas,
 *   so the draw loop is exactly ONE drawImage per tile. Water shimmer, shore foam, wet
 *   sand, node sprites, glows and the vignettes are pre-baked the same way.
 *
 *   Nothing inside the frame loop allocates: no gradients, no string building in hot
 *   paths, no object literals per frame. The world is 1024x1024 and has to stay smooth
 *   on a phone, so the pixelated look is preserved (imageSmoothingEnabled = false) and
 *   every sprite is built at boot or on first use, then cached.
 *
 * The server is authoritative: it sends state, this file makes it look like a game.
 */
'use strict';
(function () {
  var T = window.Terrain;
  var TS = 16, W = T.W, H = T.H, CHUNK = T.CHUNK;
  var RELEASE = 0, TAU = Math.PI * 2;
  var SWING = 0.30;                                   // seconds of attack animation

  // ---------- materials ----------------------------------------------------
  var CLR = {
    0: [18, 20, 26], 1: [110, 78, 46], 2: [74, 139, 59], 3: [123, 127, 138],
    4: [217, 201, 138], 5: [47, 110, 168], 6: [138, 90, 43], 7: [168, 69, 47],
    8: [159, 216, 232], 9: [154, 147, 132], 10: [255, 212, 121], 11: [58, 107, 52],
    12: [92, 96, 104], 13: [176, 138, 62], 14: [232, 238, 244], 15: [47, 107, 42]
  };
  var MATNAME = {
    1: 'dirt', 2: 'grass', 3: 'stone', 4: 'sand', 5: 'water', 6: 'wood',
    7: 'brick', 8: 'glass', 9: 'flagstone', 10: 'lamp'
  };
  var PALETTE = T.PALETTE;
  var WATER = 5, VOID = 0, SAND = 4;
  // Elevation rank. Only used for shoreline work (foam on the sea side, wet sand on the
  // land side) and for the map legend; edge treatment is generic so any future material
  // still tiles correctly.
  var RANK = { 0: 0, 5: 0, 4: 1, 2: 2, 11: 2, 15: 2, 1: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 3: 5, 13: 5, 12: 6, 14: 7 };

  // species index -> colour, per map. The species lists have grown past three, so every
  // index of the current tables gets its own tone; anything past the end wraps (a species
  // added tomorrow gets a colour instead of a crash).
  var MONCLR = {
    0: ['#7fae5a', '#8f6fa0', '#9c8f7a', '#6f93b0', '#b07a4a', '#a8b06a'],
    1: ['#c2552f', '#7a3b2a', '#b07f6a', '#d08a3c', '#8f5f4a', '#9c7a5a'],
    2: ['#4f8fae', '#9c7f5a', '#7fc4d8', '#5aa0a0', '#c0a060', '#88b8c8']
  };
  var NODECLR = { 1: '#3f7a34', 2: '#8a7f6a', 3: '#7fc45a', 4: '#8fe4ff' };

  // ---------- little maths -------------------------------------------------
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
  function rng(x, y, s) { return T.r01(x | 0, y | 0, s | 0); }

  // ---------- tile painting ------------------------------------------------
  // A tile face is built from: fine grain + soft clumps + material detail. `vi` selects
  // one of 16 variants: 4 patterns x 4 tints (the tint comes from a coarse hash, so
  // neighbouring tiles differ while whole patches share a tone).
  var VAR = 16, TINT = [-12, -4, 5, 12];

  function newPx() { return new Uint8ClampedArray(TS * TS * 4); }

  function put(out, x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= TS || y >= TS || a <= 0) return;
    var i = (y * TS + x) << 2, ia = 1 - a;
    out[i] = out[i] * ia + r * a;
    out[i + 1] = out[i + 1] * ia + g * a;
    out[i + 2] = out[i + 2] * ia + b * a;
    out[i + 3] = 255;
  }
  function putS(out, x, y, c, d, a) { put(out, x, y, c[0] + d, c[1] + d, c[2] + d, a); }
  function line(out, x0, y0, x1, y1, c, d, a) {
    var n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) | 0;
    if (n === 0) { putS(out, x0 | 0, y0 | 0, c, d, a); return; }
    for (var i = 0; i <= n; i++) {
      putS(out, Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), c, d, a);
    }
  }
  function disc(out, cx, cy, rad, c, d, a) {
    var r0 = Math.ceil(rad);
    for (var y = (cy - r0) | 0; y <= cy + r0; y++) {
      for (var x = (cx - r0) | 0; x <= cx + r0; x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= rad * rad) putS(out, x, y, c, d, a);
      }
    }
  }
  function box(out, x0, y0, x1, y1, c, d, a) {
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) putS(out, x, y, c, d, a);
  }

  function paintTile(m, vi, out) {
    var pat = vi >> 2, tint = TINT[vi & 3];
    var base = CLR[m] || CLR[0];
    var s = 1301 + m * 977 + pat * 37;
    var i, j, v, y, x;

    for (y = 0; y < TS; y++) {
      var light = -(y - 7.5) * 0.85;                    // gentle top-lit ramp
      for (x = 0; x < TS; x++) {
        var n = (rng(x * 3 + pat * 29, y * 5 + m * 7, s) - 0.5) * 18;
        var cl = (rng(x >> 1, y >> 1, s + 11) - 0.5) * 26;
        var d = n + cl + light + tint;
        put(out, x, y, base[0] + d, base[1] + d, base[2] + d, 1);
      }
    }

    switch (m) {
      case 0:                                           // void — a few cold sparks
        for (i = 0; i < 3; i++) {
          putS(out, (rng(i * 5, 3, s) * TS) | 0, (rng(3, i * 5, s + 1) * TS) | 0, base, 34, 0.85);
        }
        break;

      case 1:                                           // dirt — clods and pebbles
        for (i = 0; i < 7; i++) {
          var dx1 = 1 + ((rng(i * 13, 5, s) * (TS - 4)) | 0), dy1 = 1 + ((rng(7, i * 17, s + 1) * (TS - 4)) | 0);
          var rr = 1 + rng(i, i * 3, s + 2) * 1.8;
          disc(out, dx1, dy1, rr, base, 17, 0.5);
          disc(out, dx1, dy1 + 1, rr * 0.8, base, -24, 0.34);
        }
        for (i = 0; i < 5; i++) {
          putS(out, (rng(i * 9, 2, s + 3) * TS) | 0, (rng(2, i * 9, s + 4) * TS) | 0, base, -32, 0.5);
        }
        break;

      case 2: case 11: {                                // grass / dark grass — blades
        var gd = (m === 11) ? -8 : 0;
        for (i = 0; i < 16; i++) {
          var bxp = (rng(i * 7, 3, s) * TS) | 0, byp = 2 + ((rng(3, i * 11, s + 1) * (TS - 3)) | 0);
          var len = 2 + ((rng(i, 9, s + 2) * 3) | 0);
          line(out, bxp, byp, bxp + ((i % 3) - 1), byp - len, base, 27 + gd, 0.5);
          putS(out, bxp, byp + 1, base, -30, 0.4);
        }
        if ((vi & 3) === 3) {                           // occasional tuft
          var tx = 3 + ((rng(1, 1, s) * 9) | 0), ty = 4 + ((rng(2, 2, s) * 9) | 0);
          disc(out, tx, ty, 2.4, base, -20, 0.4);
          disc(out, tx, ty - 1, 1.6, base, 22, 0.35);
        }
        break;
      }

      case 3: case 12: {                                // stone / rock — strata + a crack
        var step = (m === 12) ? 6 : 5;
        for (i = 0; i < 3; i++) {
          var sy = 2 + i * step + ((rng(i, 1, s) * 2) | 0);
          line(out, 0, sy, TS - 1, sy + (i - 1), base, 22, 0.28);
          line(out, 0, sy + 1, TS - 1, sy + i, base, -28, 0.3);
        }
        var cx0 = 2 + ((rng(1, 5, s) * 12) | 0);
        line(out, cx0, 0, cx0 + 4 - ((rng(2, 6, s) * 8) | 0), TS - 1, base, -40, 0.4);
        for (j = 0; j < 5; j++) {
          putS(out, (rng(j * 3, 4, s) * TS) | 0, (rng(4, j * 3, s) * TS) | 0, base, 26, 0.35);
        }
        break;
      }

      case 4:                                           // sand — wind ripples
        for (y = 0; y < TS; y++) {
          for (x = 0; x < TS; x++) {
            v = Math.sin((x * 0.55 + y * 1.35 + vi * 0.7) * 0.9);
            if (v > 0.72) putS(out, x, y, base, 15, 0.45);
            else if (v < -0.78) putS(out, x, y, base, -17, 0.4);
          }
        }
        break;

      case 5:                                           // water — wave bands
        for (y = 0; y < TS; y++) {
          var deep = y / TS;
          var band = Math.sin((y + vi * 1.7) * 0.75) * 0.5 + 0.5;
          for (x = 0; x < TS; x++) {
            v = Math.sin((x * 0.55 + y * 1.5 + vi) * 0.8);
            putS(out, x, y, base, 13 - deep * 32 + band * 12 + (v > 0.65 ? 15 : 0), 1);
          }
        }
        break;

      case 6:                                           // wood — planks
        for (x = 5; x < TS; x += 8) box(out, x, 0, x, TS - 1, base, -48, 0.5);
        for (y = 0; y < TS; y += 3) line(out, 0, y + (y % 2), TS - 1, y + (y % 2), base, 18, 0.16);
        box(out, 0, 0, TS - 1, 0, base, 28, 0.3);
        break;

      case 7:                                           // brick — staggered courses
        box(out, 0, 7, TS - 1, 8, base, -52, 0.55);
        box(out, 0, 15, TS - 1, 15, base, -52, 0.55);
        box(out, 3, 0, 4, 6, base, -52, 0.5);
        box(out, 11, 9, 12, 15, base, -52, 0.5);
        box(out, 0, 0, TS - 1, 0, base, 24, 0.3);
        box(out, 0, 9, TS - 1, 9, base, 24, 0.25);
        break;

      case 8:                                           // glass — pane with a glint
        for (i = 0; i < TS; i++) { putS(out, i, i, base, 62, 0.3); putS(out, i, i + 1, base, 30, 0.18); }
        box(out, 0, 0, TS - 1, 0, base, 42, 0.4);
        box(out, 0, TS - 1, TS - 1, TS - 1, base, -42, 0.4);
        box(out, 0, 0, 0, TS - 1, base, 22, 0.3);
        break;

      case 9:                                           // flagstone
        box(out, 0, 7, TS - 1, 8, base, -42, 0.45);
        box(out, 7, 0, 8, 6, base, -42, 0.45);
        box(out, 3, 9, 4, 15, base, -42, 0.45);
        box(out, 11, 9, 12, 15, base, -42, 0.45);
        box(out, 0, 0, TS - 1, 0, base, 20, 0.25);
        box(out, 9, 1, 15, 6, base, 11, 0.18);
        break;

      case 10:                                          // lamp post foot
        disc(out, 8, 10, 5, base, -28, 0.5);
        box(out, 7, 2, 9, 14, base, -12, 0.6);
        disc(out, 8, 4, 3, base, 62, 0.5);
        break;

      case 13: {                                        // ore — readable veins
        for (i = 0; i < 3; i++) {
          var oy = 2 + i * 5;
          line(out, 0, oy, TS - 1, oy + (i - 1), base, 16, 0.25);
          line(out, 0, oy + 2, TS - 1, oy + i + 1, base, -30, 0.3);
        }
        var ore = [236, 198, 104];
        var vn = 2 + (vi & 1);
        for (var vtx = 0; vtx < vn; vtx++) {            // the vein itself, with underglow
          var ax = 2 + ((rng(vtx * 5, 1, s) * 10) | 0), ay = 9 + ((rng(2, vtx * 5, s) * 5) | 0);
          var bxx = ax + 2 + ((rng(vtx, 3, s) * 7) | 0), byy = ay - 6 - ((rng(4, vtx, s) * 6) | 0);
          line(out, ax, ay + 1, bxx, byy + 1, ore, -80, 0.28);
          line(out, ax, ay, bxx, byy, ore, 0, 0.95);
          disc(out, ax, ay, 1.5, ore, -34, 0.75);
          disc(out, bxx, byy, 1.2, ore, 52, 0.8);
        }
        for (var gl = 0; gl < 3; gl++) {
          putS(out, (rng(gl * 7, 8, s) * TS) | 0, (rng(8, gl * 7, s) * TS) | 0, ore, 72, 0.7);
        }
        break;
      }

      case 14:                                          // snow — grain and sparkle
        for (i = 0; i < 6; i++) {
          var sx = (rng(i * 11, 3, s) * (TS - 1)) | 0, sy2 = (rng(3, i * 11, s) * (TS - 1)) | 0;
          putS(out, sx, sy2, base, 26, 0.7);
          putS(out, sx + 1, sy2, base, -22, 0.25);
        }
        for (y = 0; y < TS; y += 4) line(out, 0, y, TS - 1, y, base, -15, 0.16);
        break;

      case 15:                                          // canopy
        for (i = 0; i < 6; i++) {
          var lx = 2 + ((rng(i * 9, 1, s) * 12) | 0), ly = 2 + ((rng(1, i * 9, s) * 12) | 0);
          var lr = 3 + rng(i, i, s + 5) * 2.5;
          disc(out, lx, ly, lr, base, -36, 0.45);
          disc(out, lx, ly - 1.5, lr * 0.85, base, 24, 0.4);
        }
        for (j = 0; j < 4; j++) {
          putS(out, (rng(j * 3, 6, s) * TS) | 0, (rng(6, j * 3, s) * TS) | 0, base, -52, 0.4);
        }
        break;
    }
    return out;
  }

  // ---------- composite cache ---------------------------------------------
  // key = ((mat << 4 | variant) << 8) | signature
  //   signature bits 0-3 : neighbouring tile has a different material, on that side
  //   signature bits 4-7 : both sides of that corner differ (corner occlusion, strong)
  var PX = null, COMP = new Map(), COMP_MAX = 1500, COMP_SOFT = 0;
  var bakeCv = document.createElement('canvas');
  bakeCv.width = TS; bakeCv.height = TS;
  var bakeCtx = bakeCv.getContext('2d');
  var bakeImg = bakeCtx.createImageData(TS, TS);
  var bakePx = bakeImg.data;

  function applySig(dst, sig) {
    var side, t, k;
    for (side = 0; side < 4; side++) {
      if (!(sig & (1 << side))) continue;
      for (t = 0; t < 5; t++) {                          // contact shadow, fading inward
        var a = 0.42 * (1 - t / 5);
        if (t === 0) a = 0.55;
        for (k = 0; k < TS; k++) {
          if (side === 0) put(dst, k, t, 0, 0, 0, a);
          else if (side === 2) put(dst, k, TS - 1 - t, 0, 0, 0, a);
          else if (side === 3) put(dst, t, k, 0, 0, 0, a);
          else put(dst, TS - 1 - t, k, 0, 0, 0, a);
        }
      }
      for (k = 0; k < TS; k++) {                         // a lit lip just past the shadow
        if (side === 0) put(dst, k, 5, 255, 250, 235, 0.13);
        else if (side === 2) put(dst, k, TS - 6, 255, 250, 235, 0.13);
        else if (side === 3) put(dst, 5, k, 255, 250, 235, 0.13);
        else put(dst, TS - 6, k, 255, 250, 235, 0.13);
      }
    }
    for (var c = 0; c < 4; c++) {                        // corner ambient occlusion
      var cx = (c === 0 || c === 1) ? TS - 1 : 0;
      var cy = (c === 0 || c === 3) ? 0 : TS - 1;
      var A = (sig & (16 << c)) ? 0.30 : 0.085;
      for (var dy = 0; dy < 4; dy++) {
        for (var dx = 0; dx < 4; dx++) {
          var lx = cx === 0 ? dx : cx - dx, ly = cy === 0 ? dy : cy - dy;
          var fall = Math.max(dx, dy);
          var a2 = A * (1 - fall / 4);
          if (a2 > 0.006) put(dst, lx, ly, 0, 0, 0, a2);
        }
      }
    }
  }

  function bakeComposite(mat, vi, sig) {
    bakePx.set(PX[mat * VAR + vi]);
    if (sig) applySig(bakePx, sig);
    bakeCtx.putImageData(bakeImg, 0, 0);
    var c = document.createElement('canvas');
    c.width = TS; c.height = TS;
    c.getContext('2d').drawImage(bakeCv, 0, 0);
    return c;
  }

  function composite(mat, vi, sig) {
    var key = ((mat << 4 | vi) << 8) | sig;
    var c = COMP.get(key);
    if (c !== undefined) return c;
    if (COMP.size >= COMP_MAX) {                         // drop the oldest quarter
      var it = COMP.keys(), drop = COMP_MAX >> 2;
      for (var i = 0; i < drop; i++) { var nx = it.next(); if (nx.done) break; COMP.delete(nx.value); }
    }
    c = bakeComposite(mat, vi, sig);
    COMP.set(key, c);
    return c;
  }

  function buildBasePixels() {
    PX = [];
    for (var m = 0; m < 16; m++) {
      for (var v = 0; v < VAR; v++) PX[m * VAR + v] = paintTile(m, v, newPx());
    }
    for (var m2 = 0; m2 < 16; m2++) for (var v2 = 0; v2 < VAR; v2++) composite(m2, v2, 0);
    COMP_SOFT = 1;
  }

  // coarse patches of tint keep the field from looking like static
  function variantAt(x, y) {
    return (T.hash2(x, y, 3) & 3) | ((T.hash2(x >> 2, y >> 2, 9) & 3) << 2);
  }

  // ---------- small sprites (nodes, glows, water, vignettes) ---------------
  function spr(size, draw) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    draw(g, size);
    return c;
  }
  function sel(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }

  var NODESPR = {}, SHIM = [], FOAM = [], WET = [], GLOW_LAMP = null, GLOW_CRYS = null, GLOW_WARN = null;
  var VIG_DARK = null, VIG_RED = null;

  function buildNodeSprites() {
    NODESPR[1] = []; NODESPR[2] = []; NODESPR[3] = []; NODESPR[4] = [];
    for (var i = 0; i < 3; i++) {
      var o = i - 1;
      NODESPR[1].push(spr(TS, function (g, S2) {          // tree
        var k = o;
        g.fillStyle = '#4a3320'; g.fillRect(7 + (k > 0 ? 1 : 0), 8, 2, 6);
        g.fillStyle = 'rgba(0,0,0,.34)'; g.fillRect(9 + (k > 0 ? 1 : 0), 9, 1, 5);
        g.fillStyle = '#2f5a26'; sel(g, 8 + k, 6.4, 5.6, 4.8);
        g.fillStyle = '#3d7a31'; sel(g, 7.6 + k, 5.4, 4.3, 3.5);
        g.fillStyle = '#57a041'; sel(g, 7.0 + k, 4.6, 2.6, 1.9);
        g.fillStyle = 'rgba(190,240,160,.22)'; sel(g, 6.4 + k, 4.1, 1.3, 0.9);
        g.fillStyle = 'rgba(0,0,0,.26)'; sel(g, 10.4 + k, 7.6, 2.1, 1.9);
      }));
      NODESPR[2].push(spr(TS, function (g) {              // ore seam
        var k = o;
        g.fillStyle = '#5f5a50'; sel(g, 8, 10.4, 5.2, 4.2);
        g.fillStyle = '#6f6a5e'; sel(g, 7.6, 9.6, 4.2, 3.2);
        g.fillStyle = 'rgba(0,0,0,.3)'; sel(g, 8, 11.8, 4.6, 2.2);
        g.fillStyle = '#c9a05a'; g.fillRect(6 + k, 8, 3, 2);
        g.fillStyle = '#eccf7e'; g.fillRect(9 + k, 10, 2, 2);
        g.fillStyle = '#f6e6ac'; g.fillRect(6 + k, 8, 1, 1);
        g.fillStyle = 'rgba(236,198,104,.35)'; g.fillRect(5 + k, 7, 6, 4);
      }));
    }
    for (var j = 0; j < 2; j++) {
      NODESPR[3].push(spr(TS, function (g) {              // herb
        var k = j;
        g.strokeStyle = '#3f7a34'; g.lineWidth = 1.4; g.lineCap = 'round';
        for (var i2 = -1; i2 <= 1; i2++) {
          g.beginPath();
          g.moveTo(8 + i2 * 2 + k, 13.5);
          g.lineTo(8 + i2 * 3.4 + k, 6 - Math.abs(i2) * 0.8);
          g.stroke();
        }
        g.fillStyle = '#8fd05e'; sel(g, 8 + k, 5.4, 1.6, 1.3);
        g.fillStyle = '#c8e98f'; sel(g, 7.7 + k, 5.1, 0.8, 0.7);
      }));
      NODESPR[4].push(spr(TS, function (g) {              // crystal
        var k = j;
        g.fillStyle = '#8fe4ff';
        g.beginPath(); g.moveTo(8, 2.4); g.lineTo(11, 10.6); g.lineTo(5, 10.6); g.closePath(); g.fill();
        g.fillStyle = '#c8f4ff';
        g.beginPath(); g.moveTo(8, 2.4); g.lineTo(9.4, 10.6); g.lineTo(7.2, 10.6); g.closePath(); g.fill();
        g.fillStyle = '#6fc4e0';
        g.beginPath(); g.moveTo(11.4 + k, 6.4); g.lineTo(13.4, 12.4); g.lineTo(9.6, 12.4); g.closePath(); g.fill();
      }));
    }
  }

  function buildWaterSprites() {
    for (var k = 0; k < 8; k++) {
      SHIM.push(spr(TS, function (g) {
        g.fillStyle = 'rgba(206,238,255,.20)';
        for (var i = 0; i < 3; i++) {
          var y = (k * 5 + i * 6) % TS, x0 = (k * 3 + i * 7) % TS;
          g.fillRect(x0, y, 3, 1);
          g.fillRect((x0 + 8) % TS, (y + 4) % TS, 2, 1);
        }
        g.fillStyle = 'rgba(255,255,255,.24)';
        g.fillRect((k * 7) % 14, (k * 3) % 14, 2, 1);
      }));
    }
    for (var side = 0; side < 4; side++) {
      FOAM.push(spr(TS, function (g) {
        for (var i = 0; i < TS; i++) {
          var h = 2 + ((Math.sin(i * 1.7) * 1.4 + (i % 3) * 0.5 + 0.6) | 0);
          for (var t = 0; t < h; t++) {
            g.fillStyle = 'rgba(238,250,255,' + (0.5 * (1 - t / (h + 1))).toFixed(3) + ')';
            if (side === 0) g.fillRect(i, t, 1, 1);
            else if (side === 2) g.fillRect(i, TS - 1 - t, 1, 1);
            else if (side === 3) g.fillRect(t, i, 1, 1);
            else g.fillRect(TS - 1 - t, i, 1, 1);
          }
        }
      }));
      WET.push(spr(TS, function (g) {                     // damp sand beside the sea
        for (var i = 0; i < TS; i++) {
          for (var t = 0; t < 6; t++) {
            var a = 0.42 * (1 - t / 6);
            g.fillStyle = 'rgba(38,66,92,' + a.toFixed(3) + ')';
            if (side === 0) g.fillRect(i, t, 1, 1);
            else if (side === 2) g.fillRect(i, TS - 1 - t, 1, 1);
            else if (side === 3) g.fillRect(t, i, 1, 1);
            else g.fillRect(TS - 1 - t, i, 1, 1);
          }
        }
        for (var j = 0; j < 4; j++) {                     // wet glints
          g.fillStyle = 'rgba(212,240,255,.22)';
          var y = (j * 5 + 2) % TS;
          if (side === 0) g.fillRect(j * 4, 1, 2, 1);
          else if (side === 2) g.fillRect(j * 4, TS - 2, 2, 1);
          else if (side === 3) g.fillRect(1, y, 1, 2);
          else g.fillRect(TS - 2, y, 1, 2);
        }
      }));
    }
  }

  function mkGlow(rgb, size) {
    return spr(size, function (g, sz) {
      var grd = g.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
      grd.addColorStop(0, 'rgba(' + rgb + ',0.55)');
      grd.addColorStop(0.45, 'rgba(' + rgb + ',0.20)');
      grd.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, sz, sz);
    });
  }

  function buildVignette() {
    var N = 64;
    VIG_DARK = spr(N, function (g) {
      var grd = g.createRadialGradient(N / 2, N / 2, N * 0.28, N / 2, N / 2, N * 0.72);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, 'rgba(3,4,8,0.72)');
      g.fillStyle = grd; g.fillRect(0, 0, N, N);
    });
    VIG_RED = spr(N, function (g) {
      var grd = g.createRadialGradient(N / 2, N / 2, N * 0.10, N / 2, N / 2, N * 0.62);
      grd.addColorStop(0, 'rgba(150,10,6,0)');
      grd.addColorStop(0.62, 'rgba(170,18,10,0.42)');
      grd.addColorStop(1, 'rgba(214,40,22,0.92)');
      g.fillStyle = grd; g.fillRect(0, 0, N, N);
    });
  }

  // ---------- species / creature forms ------------------------------------
  // The form is what a species LOOKS like. terrain.js owns the species table; if it ever
  // grows a `form` field we honour it, otherwise we derive the form from the species
  // name so a new beast still gets a body instead of a coloured blob.
  var FORMS = ['blob', 'brute', 'spitter', 'swarm', 'tank', 'wisp', 'skirmisher', 'pack'];
  var FORM_BY_KIND = {
    MOSS_HOPPER: 'skirmisher', THICKET_MAW: 'blob', STONE_SKITTER: 'swarm',
    CINDER_HOUND: 'pack', SLAG_WRETCH: 'tank', BRINE_LURKER: 'spitter', SHELL_BRUTE: 'brute',
    BOG_WISP: 'wisp', GLOOM_SHADE: 'wisp', IRON_OCHRE: 'tank', PRICKLE_SPITTER: 'spitter'
  };
  var FORM_HINT = [
    [/ooze|slime|blob|maw|gullet|sap/i, 'blob'],
    [/hound|wolf|pack|jackal|hyena|boar/i, 'pack'],
    [/swarm|skitter|locust|hive|bug|mite|rath/i, 'swarm'],
    [/spit|lurk|brine|toad|venom|spore/i, 'spitter'],
    [/tank|shell|wretch|golem|coloss|slab|slag/i, 'tank'],
    [/brute|brawler|husk|ox|giant|troll|shell/i, 'brute'],
    [/wisp|shade|spirit|ghost|wraith|gloom/i, 'wisp'],
    [/hopper|skirm|runner|imp|flick|lurcher/i, 'skirmisher']
  ];

  function speciesOf(map, kind) {
    var k = Math.abs(kind | 0);
    if (typeof T.speciesOf === 'function') {
      var s0 = T.speciesOf(map, k);
      if (s0) return s0;
    }
    var list = T.SPECIES[map] || T.SPECIES[0] || [];
    if (!list || !list.length) return null;
    return list[k % list.length] || null;
  }
  // terrain.js owns the form strings. Anything unfamiliar is folded onto a painter we
  // do have, so a species added tomorrow still gets a body instead of a bare ellipse.
  var FORM_ALIAS = {
    hound: 'pack', wolf: 'pack', quadruped: 'pack', dog: 'pack', crawler: 'swarm',
    slime: 'blob', ooze: 'blob', orb: 'wisp', ghost: 'wisp', shade: 'wisp',
    crab: 'tank', beetle: 'tank', bird: 'skirmisher', humanoid: 'skirmisher', kiter: 'skirmisher'
  };
  var FORM_SET = { blob: 1, brute: 1, spitter: 1, swarm: 1, tank: 1, wisp: 1, skirmisher: 1, pack: 1 };
  function paintKey(f) {
    if (!f) return 'blob';
    f = String(f).toLowerCase();
    if (FORM_ALIAS[f]) return FORM_ALIAS[f];
    return FORM_SET[f] ? f : 'blob';
  }
  function formOf(sp, kind) {
    if (sp && typeof sp.form === 'string' && sp.form) return paintKey(sp.form);
    var nm = (sp && sp.kind) ? String(sp.kind) : '';
    if (FORM_BY_KIND[nm]) return paintKey(FORM_BY_KIND[nm]);
    for (var i = 0; i < FORM_HINT.length; i++) {
      if (FORM_HINT[i][0].test(nm)) return paintKey(FORM_HINT[i][1]);
    }
    return paintKey(FORMS[Math.abs(kind | 0) % FORMS.length]);
  }
  function hex2rgb(h) {
    var v = parseInt(String(h).replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function mixc(c, k) {
    return 'rgb(' + clamp255(c[0] * k) + ',' + clamp255(c[1] * k) + ',' + clamp255(c[2] * k) + ')';
  }
  function makePal(hex) {
    var c = hex2rgb(hex);
    return {
      hex: hex, body: hex, dark: mixc(c, 0.58), shade: mixc(c, 0.78),
      light: mixc(c, 1.3), glowc: mixc(c, 1.65), name: String(hex)
    };
  }
  function spName(map, kind) {
    var sp = speciesOf(map, kind);
    return sp && sp.kind ? String(sp.kind).replace(/_/g, ' ') : 'BEAST';
  }
  function monPal(map, kind) {
    var pal = MONCLR[map] || MONCLR[0];
    return makePal(pal[Math.abs(kind | 0) % pal.length] || '#9c8f7a');
  }

  var S = {
    key: localStorage.getItem('stratum_key') || newKey(),
    name: localStorage.getItem('stratum_name') || '',
    map: 0, maps: [], mapName: '',
    x: 0, y: 0, energy: 240, energyMax: 240, reach: 6, attackRange: 3,
    hp: 100, maxHp: 100, atk: 7, kills: 0, inv: { wood: 0, ore: 0, herb: 0, crystal: 0 },
    claimed: 0, total: W * H, online: 0, volatile: null,
    sel: 0, zoom: 1, ready: false,
    cam: { x: 0, y: 0 }, mouse: { x: 0, y: 0 },
    edits: new Map(), baseCache: new Map(), lamps: new Set(),
    nodes: new Map(),          // "x,y" -> {kind,state,until,x,y}
    mons: new Map(),           // id -> {id,kind,x,y,rx,ry,hp,maxHp,hit,sw,dt,x?,pal,form}
    drops: new Map(),          // "x,y" -> {id,x,y,res,at,ttlMs}
    structures: new Map(),     // "x,y" -> {id,kind,x,y,owner,accrued,capacity,resource}
    placingStructure: null,    // kind selected in the [I] idle panel, armed for the next LMB
    idleOpen: false,
    remotes: new Map(), floats: [],
    lastViewCk: '', mapOpen: false, travelOpen: false, mapDensity: null, lastEnergySync: 0,
    // presentation state
    faceX: 0, faceY: 1, moving: 0, walk: 0, joy: null,
    swingT: -1, swingA: 0, swingDX: 1, swingDY: 0,
    shake: 0, hurt: 0, death: -1, dt: 0.016, hudAt: 0,
    target: null, targetUntil: 0,
    // harvest-first onboarding: block place until first successful harvest (or prior unlock)
    harvests: 0,
    canBuild: localStorage.getItem('stratum_can_build') === '1',
    // first-session quest counters (personal — not world claim %)
    personalClaims: 0,
    craftOpens: 0,
    crafts: 0,
    mapsSeen: {},
    achUnlocked: 0, achTitle: null
  };
  if (S.canBuild && S.harvests < 1) S.harvests = 1; // returning builders already passed harvest
  localStorage.setItem('stratum_key', S.key);
  function unlockBuild() {
    if (S.canBuild) return;
    S.canBuild = true;
    try { localStorage.setItem('stratum_can_build', '1'); } catch (e) {}
    var sel = document.getElementById('h-sel');
    if (sel) sel.textContent = 'building: ' + MATNAME[PALETTE[S.sel]];
  }
  function newKey() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function tk(x, y) { return y * W + x; }
  function nkN(x, y) { return x + ',' + y; }

  // Chunk keys are numeric: a string key per lookup would allocate once per tile per
  // frame, which is exactly the kind of garbage a phone cannot afford.
  function baseAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    var cx = x >> 5, cy = y >> 5;                       // CHUNK === 32
    var ck = ((S.map * 64 + cx) << 8) | cy;
    var arr = S.baseCache.get(ck);
    if (!arr) {
      if (S.baseCache.size > 2600) S.baseCache.clear();
      arr = T.buildChunk(S.map, cx, cy);
      S.baseCache.set(ck, arr);
    }
    return arr[((y & 31) << 5) + (x & 31)];
  }
  function tileAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    var e = S.edits.get(tk(x, y));
    return e ? e.m : baseAt(x, y);
  }
  function setLamp(k, mat) { if (mat === 10) S.lamps.add(k); else S.lamps.delete(k); }

  // ---------- canvas -------------------------------------------------------
  var cv = document.getElementById('c');
  var ctx = cv.getContext('2d', { alpha: false });
  var VW = 0, VH = 0;
  function resize() {
    var DPR = Math.min(2, window.devicePixelRatio || 1);
    // Size from the VISUAL viewport. On mobile the layout viewport lies (browser chrome
    // collapsing, keyboard opening), which leaves the world drawn off-centre.
    var vv = window.visualViewport;
    VW = Math.round(vv ? vv.width : window.innerWidth);
    VH = Math.round(vv ? vv.height : window.innerHeight);
    cv.style.width = VW + 'px'; cv.style.height = VH + 'px';
    cv.width = (VW * DPR) | 0; cv.height = (VH * DPR) | 0;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (S.cam) { S.cam.x = S.x; S.cam.y = S.y; }      // snap, don't slide across the world
  }
  function unpan() { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 150); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', resize);
    window.visualViewport.addEventListener('scroll', unpan);
  }

  // ---------- net ----------------------------------------------------------
  var ws = null, wsReady = false, moveAcc = 0;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = function () { wsReady = true; send({ t: 'hello', key: S.key, name: S.name }); };
    ws.onclose = function () { wsReady = false; setTimeout(connect, 1500); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'err') { toast(m.err, false); return; }
      onServer(m);
    };
  }
  function send(o) { if (ws && wsReady && ws.readyState === 1) try { ws.send(JSON.stringify(o)); } catch (e) { } }
  // Procedural sound, loaded from audio.js as window.SFX. Every call is guarded:
  // an old cached page without audio.js, or a browser with no Web Audio, plays mute.
  function sfx(n, o) { try { if (window.SFX && SFX.play) SFX.play(n, o); } catch (e) {} }
  // Browsers keep the AudioContext suspended until a real gesture. Cheap and
  // idempotent — call it from every gesture handler, not just the first.
  function unlockAudio() { try { if (window.SFX && SFX.unlock) SFX.unlock(); } catch (e) {} }
  function b64ToBytes(b) {
    var bin = atob(b), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  // Unknown message types (and unknown extra fields inside known ones) are ignored:
  // the server may learn new tricks before this client does.
  function onServer(m) {
    switch (m.t) {
      case 'welcome':
        S.ready = true; S.map = m.map; S.maps = m.maps;
        S.x = m.x; S.y = m.y; S.cam.x = m.x; S.cam.y = m.y;
        S.energy = m.energy; S.energyMax = m.energyMax; S.reach = m.reach; S.attackRange = m.attackRange;
        S.hp = m.hp; S.maxHp = m.maxHp; S.atk = m.atk; S.kills = m.kills; S.inv = m.inv;
        S.tool = (typeof m.tool === 'number') ? m.tool : 0;
        S.level = (typeof m.level === 'number' && m.level > 0) ? m.level : 1;
        S.catalog = m.catalog || null;
        S.claimed = m.claimed; S.total = m.total; S.online = m.online;
        if (S.maps && S.maps.length) setMapName();
        noteMapVisit(S.map);
        buildHotbar();
        document.getElementById('h-name').textContent = m.name;
        document.getElementById('gate').style.display = 'none';
        refreshQuest(true);
        break;

      case 'arrived':
        S.map = m.map; S.maps = m.maps; S.x = m.x; S.y = m.y;
        S.cam.x = m.x; S.cam.y = m.y;
        S.edits.clear(); S.nodes.clear(); S.mons.clear(); S.drops.clear(); S.structures.clear(); S.baseCache.clear(); S.lamps.clear(); S.lastViewCk = '';
        S.claimed = m.claimed; S.total = m.total;
        setMapName(); closeTravel(); closeCraft();
        noteMapVisit(S.map);
        toast('ARRIVED — ' + m.name, true);
        refreshQuest(true);
        break;

      case 'chunk': {
        if (m.map !== S.map) break;
        var d = b64ToBytes(m.d);
        for (var i = 0; i + 3 < d.length; i += 4) {
          var kk = tk(m.cx * CHUNK + d[i], m.cy * CHUNK + d[i + 1]);
          S.edits.set(kk, { m: d[i + 2], owner: m.owners[d[i + 3]] });
          setLamp(kk, d[i + 2]);
        }
        if (m.nodes) for (var n = 0; n < m.nodes.length; n++) applyNode(m.nodes[n]);
        if (m.drops) for (var dn = 0; dn < m.drops.length; dn++) applyDrop(m.drops[dn]);
        if (m.structures) for (var sn = 0; sn < m.structures.length; sn++) applyStructure(m.structures[sn]);
        if (S.edits.size > 400000) pruneEdits();
        break;
      }

      case 'tiles': {
        if (!m.list || !m.list.length) break;
        for (var L = 0; L < m.list.length; L++) {
          var l = m.list[L], tl = tk(l[0], l[1]);
          if (l[2] === -1) { S.edits.delete(tl); S.lamps.delete(tl); }
          else { S.edits.set(tl, { m: l[2], owner: l[3] }); setLamp(tl, l[2]); }
        }
        break;
      }
      case 'unclaim':
        S.edits.delete(tk(m.x, m.y)); S.lamps.delete(tk(m.x, m.y)); S.claimed = m.claimed;
        break;
      case 'you': {
        var yk = tk(m.x, m.y);
        S.energy = m.energy; S.claimed = m.claimed;
        if (m.inv) S.inv = m.inv;
        S.edits.set(yk, { m: m.m, owner: S.key });
        setLamp(yk, m.m);
        S.personalClaims += 1;
        if (window.StratumHud) {
          window.StratumHud.markSeenClaimStats();
          window.StratumHud.noteAction();
        }
        if (m.x === Math.round(S.x) && m.y === Math.round(S.y)) puff(m.x, m.y, '#e8e6cf', 6, 1.4);
        refreshQuest(true);
        break;
      }
      case 'node': applyNode([m.x, m.y, m.kind, m.state, m.ripeSec]); break;

      case 'drop': applyDrop(m); break;
      case 'drop-gone': S.drops.delete(nkN(m.x, m.y)); break;

      case 'structure': applyStructure(m); break;
      case 'built': {
        if (m.err) { toast(String(m.err).toUpperCase()); sfx('deny'); break; }
        if (m.inv) S.inv = m.inv;
        toast('BUILT: ' + String(m.kind || '').toUpperCase(), true);
        sfx('craft');
        if (window.StratumHud) window.StratumHud.noteAction();
        break;
      }
      case 'collected': {
        if (m.err) { toast(String(m.err).toUpperCase()); sfx('deny'); break; }
        if (m.inv) S.inv = m.inv;
        var sk = nkN(m.x, m.y);
        var se = S.structures.get(sk);
        if (se) { se.accrued = 0; }
        if (m.gained > 0) {
          toast('COLLECTED +' + m.gained + ' ' + m.resource, true);
          float(m.x, m.y, '+' + m.gained + ' ' + m.resource, '#c9e08a', 0);
          sfx('harvest');
          if (window.StratumHud) window.StratumHud.noteAction();
        } else {
          toast('NOTHING TO COLLECT YET');
        }
        break;
      }
      case 'pickup': {
        if (m.err) { if (m.err !== 'none') toast(m.err.toUpperCase()); break; }
        if (m.inv) S.inv = m.inv;
        var got = [];
        if (m.taken) for (var tk2 in m.taken) got.push(m.taken[tk2] + ' ' + tk2);
        toast(got.length ? 'PICKED UP ' + got.join(' + ') : 'PICKED UP', true);
        sfx('harvest');
        if (window.StratumHud) window.StratumHud.noteAction();
        break;
      }

      case 'harvested': {
        if (m.err) { toast(m.err.toUpperCase() + (m.wait ? ' — ' + m.wait + 's' : '')); sfx('deny'); break; }
        var nd = S.nodes.get(nkN(m.x, m.y));
        if (nd && m.state === 0) { nd.state = 0; nd.until = Date.now() + (m.ripeSec || 0) * 1000; }
        if (m.inv) S.inv = m.inv;
        if (m.gains) {
          S.harvests += 1;
          unlockBuild();
          if (window.StratumHud) window.StratumHud.noteAction();
          for (var y2 in m.gains) float(m.x, m.y, '+' + m.gains[y2] + ' ' + y2, '#c9e08a', 0);
          var ndc = NODECLR[m.kind] || '#c9e08a';
          puff(m.x + 0.5, m.y + 0.3, ndc, 7, 1.8);
          sfx('harvest');
          refreshQuest(true);
        } else if (m.partial) {
          float(m.x, m.y, 'struck', '#cbbf9a', 0);
          puff(m.x + 0.5, m.y + 0.3, '#cbbf9a', 3, 1.2);
          sfx('hit', { volume: 0.3 });
        }
        break;
      }

      case 'mons': {
        if (!m.list) break;
        var seen = new Set(), Ls = m.list, k = 0;
        for (; k < Ls.length; k++) {
          var rec = Ls[k];
          if (!rec) continue;
          var id = rec[0]; seen.add(id);
          var e = S.mons.get(id);
          if (!e) {
            e = {
              id: id, kind: rec[1], x: rec[2], y: rec[3], rx: rec[2], ry: rec[3],
              hp: rec[4], maxHp: rec[5], hit: 0, sw: 0, swx: 0, swy: 0,
              form: formOf(speciesOf(S.map, rec[1]), rec[1]), pal: monPal(S.map, rec[1]),
              nm: spName(S.map, rec[1]),
              mode: (typeof rec[6] === 'number') ? rec[6] : 0,       // combat telemetry, may be absent
              phase: (typeof rec[7] === 'number') ? rec[7] : 0
            };
            e.walk = 0; e.faceX = 0; e.faceY = 1;
            S.mons.set(id, e);
          } else {
            e.x = rec[2]; e.y = rec[3]; e.hp = rec[4]; e.maxHp = rec[5];
            if (typeof rec[6] === 'number') e.mode = rec[6];
            if (typeof rec[7] === 'number') e.phase = rec[7];
            if (rec[1] !== e.kind) {
              e.kind = rec[1];
              e.form = formOf(speciesOf(S.map, rec[1]), rec[1]);
              e.pal = monPal(S.map, rec[1]);
              e.nm = spName(S.map, rec[1]);
            }
          }
        }
        S.mons.forEach(function (v, id2) { if (!seen.has(id2)) S.mons.delete(id2); });
        break;
      }
      case 'mon':
        if (m.id === undefined) break;
        S.mons.set(m.id, {
          id: m.id, kind: m.kind, x: m.x, y: m.y, rx: m.x, ry: m.y,
          hp: (typeof m.hp === 'number' && m.maxHp > 1) ? m.hp : (m.maxHp || 1),
          maxHp: m.maxHp || 1, hit: 0, sw: 0, swx: 0, swy: 0,
          form: formOf(speciesOf(S.map, m.kind), m.kind), pal: monPal(S.map, m.kind),
          nm: spName(S.map, m.kind), faceX: 0, faceY: 1, walk: 0,
          mode: (typeof m.mode === 'number') ? m.mode : 0,
          phase: (typeof m.phase === 'number') ? m.phase : 0
        });
        break;

      // the world refusing a placement we drew optimistically — take it back
      case 'deny': {
        var dk = tk(m.x | 0, m.y | 0);
        S.edits.delete(dk); S.lamps.delete(dk);
        if (m.r === 'reach') toast('OUT OF REACH — ' + S.reach + ' TILES MAX');
        else if (m.r === 'material') toast('CANNOT PLACE THAT');
        else if (m.r === 'bounds') toast('THAT IS THE EDGE OF THE WORLD');
        else if (m.r === 'energy') toast('NO WILL LEFT');
        else if (m.r === 'resources') toast('NEED ' + costText(m.need) + (m.missing ? ' — SHORT ' + costText(m.missing) : ''));
        else if (m.r === 'owned') toast('THAT LAND IS CLAIMED. NOT YOURS.');
        else toast('THE WORLD REFUSED THAT');
        sfx('deny');
        break;
      }

      case 'combat': {
        if (m.err) { toast(String(m.err).toUpperCase()); sfx('deny'); break; }
        var mm = S.mons.get(m.id);
        if (m.killed) {
          S.kills = m.kills; S.atk = m.atk; S.inv = m.inv;
          if (typeof m.level === 'number' && m.level > (S.level || 1)) {
            S.level = m.level;
            toast('LEVEL ' + m.level + ' — LIFE AND STRENGTH GROW', true);
            sfx('levelup');
          } else {
            sfx('die');
          }
          if (window.StratumHud) window.StratumHud.noteAction();
          refreshQuest(true);
          if (mm) {
            float(mm.rx, mm.ry - 0.4, 'SLAIN', mm.pal.hex, 2);
            burst(mm.rx, mm.ry, mm.pal, 16, 2.6);
            S.mons.delete(m.id);
          }
          S.shake = Math.max(S.shake, 0.55);
          toast('SLAIN: ' + m.name + '  +1 ' + m.loot, true);
        } else {
          if (mm) {
            var dealt = Math.max(1, (mm.hp | 0) - (typeof m.hp === 'number' ? m.hp : mm.hp));
            var crit = dealt >= Math.max(9, mm.maxHp * 0.34);
            mm.hp = (typeof m.hp === 'number') ? m.hp : mm.hp;
            mm.maxHp = m.maxHp || mm.maxHp;
            mm.hit = Date.now();
            float(mm.rx, mm.ry - 0.35, '-' + dealt, crit ? '#fff2c8' : mm.pal.hex, crit ? 2 : (dealt >= 8 ? 1 : 0));
            burst(mm.rx, mm.ry, crit ? { glowc: '#fff0b8', light: '#ffffff' } : mm.pal, crit ? 14 : 8, crit ? 2.6 : 1.8);
            if (crit || dealt >= 10) S.shake = Math.max(S.shake, Math.min(0.9, 0.32 + dealt / 40));
            if (crit) sfx('crit'); else sfx('hit');
          }
          if (m.name) S.targetName = m.name;
        }
        break;
      }
      case 'dmg': {
        var before = S.hp;
        if (typeof m.hp === 'number') S.hp = m.hp;
        if (typeof m.maxHp === 'number') S.maxHp = m.maxHp;
        // the server sends the real roll when it has one; otherwise infer from the delta
        var took = (typeof m.dmg === 'number') ? Math.max(1, Math.round(m.dmg))
          : Math.max(1, Math.round(before - S.hp));
        S.hurt = Math.min(1, S.hurt + 0.5 + took / 60);
        S.shake = Math.max(S.shake, Math.min(1.1, 0.25 + took / 30));
        float(S.x, S.y - 0.5, '-' + took, '#ff8a70', took >= 12 ? 1 : 0);
        puff(S.x + 0.5, S.y + 0.3, '#ff9a80', 8, 2);
        sfx('hurt');
        // the nearest beast lunges: whatever just hit us, it should look like it meant it
        var best = null, bd = 36;
        S.mons.forEach(function (mo) {
          var dd = (mo.rx - S.x) * (mo.rx - S.x) + (mo.ry - S.y) * (mo.ry - S.y);
          if (dd < bd) { bd = dd; best = mo; }
        });
        if (best) {
          var dl = Math.sqrt(bd) || 1;
          best.swx = (S.x - best.rx) / dl; best.swy = (S.y - best.ry) / dl;
          best.sw = SWING * 1.2;
          best.hit = Date.now();
        }
        break;
      }
      case 'died':
        S.hp = m.hp; S.maxHp = m.maxHp; S.x = m.spawn.x; S.y = m.spawn.y;
        S.cam.x = S.x; S.cam.y = S.y;
        if (m.inv) S.inv = m.inv;
        S.edits.clear(); S.nodes.clear(); S.mons.clear(); S.drops.clear(); S.structures.clear(); S.baseCache.clear(); S.lamps.clear(); S.lastViewCk = '';
        S.death = 0; S.hurt = 1;
        burst(S.x, S.y, { glowc: '#ffc9a8', light: '#ffe9d2' }, 22, 3);
        S.deathBy = String(m.by || 'the world').toUpperCase();
        toast('YOU WERE SLAIN BY ' + String(m.by).toUpperCase() + ' — RETURNED TO THE SHORE');
        sfx('die', { pitch: 0.6 });
        break;
      case 'vitals':
        S.hp = m.hp; S.maxHp = m.maxHp; S.inv = m.inv; S.kills = m.kills; S.atk = m.atk;
        if (typeof m.tool === 'number') S.tool = m.tool;
        if (typeof m.level === 'number' && m.level > (S.level || 1)) { S.level = m.level; sfx('levelup'); }
        else if (typeof m.level === 'number' && m.level > 0) S.level = m.level;
        if (S.craftOpen) buildCraft();
        refreshQuest(true);
        break;
      case 'crafted': {
        if (m.err) { toast(String(m.err).toUpperCase()); sfx('deny'); break; }
        if (m.inv) S.inv = m.inv;
        S.crafts += 1;
        toast('CRAFTED: ' + String(m.item || '').toUpperCase(), true);
        sfx('craft');
        if (S.craftOpen) buildCraft();
        if (window.StratumHud) window.StratumHud.noteAction();
        refreshQuest(true);
        break;
      }
      case 'tooled': {
        if (m.err) {
          toast(String(m.err).toUpperCase() + (m.missing ? ' — SHORT ' + costText(m.missing) : ''));
          sfx('deny'); break;
        }
        if (typeof m.tool === 'number') S.tool = m.tool;
        if (m.inv) S.inv = m.inv;
        toast(String(m.name || '').toUpperCase() + ' TOOLS', true);
        sfx('levelup');
        if (S.craftOpen) buildCraft();
        if (window.StratumHud) window.StratumHud.noteAction();
        refreshQuest(true);
        break;
      }
      case 'achievements':
        S.achUnlocked = (m.unlocked && m.unlocked.length) || 0;
        S.achTitle = m.title || null;
        updateAchHud();
        break;
      case 'achievement':
        S.achUnlocked += 1;
        if (m.title) S.achTitle = m.title;
        updateAchHud();
        toast('ACHIEVEMENT: ' + m.name, true);
        sfx('levelup');
        break;
      case 'stats':
        S.claimed = m.claimed; S.total = m.total; S.online = m.online; S.volatile = m.volatile;
        break;
      case 'players': {
        if (!m.list) break;
        var seen2 = new Set();
        for (var j = 0; j < m.list.length; j++) {
          var p = m.list[j]; seen2.add(p[0]);
          var r = S.remotes.get(p[0]);
          if (!r) {
            S.remotes.set(p[0], {
              name: p[1], x: p[2], y: p[3], rx: p[2], ry: p[3], hue: p[4], lx: p[2], ly: p[3],
              faceX: 0, faceY: 1, walk: 0, moving: 0,
              // colour strings are built once, not per frame
              body: 'hsl(' + p[4] + ',58%,62%)', trim: 'hsl(' + p[4] + ',48%,40%)'
            });
          } else {
            r.x = p[2]; r.y = p[3]; r.name = p[1];
            if (typeof p[4] === 'number' && p[4] !== r.hue) {
              r.hue = p[4];
              r.body = 'hsl(' + p[4] + ',58%,62%)';
              r.trim = 'hsl(' + p[4] + ',48%,40%)';
            }
          }
        }
        S.remotes.forEach(function (v, kk) { if (!seen2.has(kk)) S.remotes.delete(kk); });
        if (m.you && Math.abs(S.energy - m.you[2]) > 4) S.energy = m.you[2];
        break;
      }
      case 'map': if (m.map === S.map && m.d) { S.mapDensity = b64ToBytes(m.d); drawMap(); } break;
      case 'pong': break;
      default: break;                                     // unknown → ignore, never throw
    }
  }

  function applyNode(a) {
    if (!a || a.length < 4) return;
    S.nodes.set(nkN(a[0], a[1]), {
      kind: a[2], state: a[3], x: a[0], y: a[1],
      until: a[3] === 0 ? 0 : Date.now() + (a[4] || 0) * 1000
    });
  }
  function applyDrop(d) {
    if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || !d.res) return;
    S.drops.set(nkN(d.x, d.y), { id: d.id, x: d.x, y: d.y, res: d.res, at: d.at, ttlMs: d.ttlMs });
  }
  function applyStructure(s) {
    if (!s || typeof s.x !== 'number' || typeof s.y !== 'number' || !s.kind) return;
    S.structures.set(nkN(s.x, s.y), {
      id: s.id, kind: s.kind, x: s.x, y: s.y, owner: s.owner,
      accrued: s.accrued || 0, capacity: s.capacity || 0, resource: s.resource
    });
  }
  function pruneEdits() {
    var keep = new Map(), lamps = new Set();
    S.edits.forEach(function (v, k) {
      var x = k % W, y = (k / W) | 0;
      if (Math.abs(x - S.x) < 400 && Math.abs(y - S.y) < 400) {
        keep.set(k, v);
        if (v.m === 10) lamps.add(k);
      }
    });
    S.edits = keep; S.lamps = lamps;
  }
  function setMapName() {
    var d = S.maps.filter(function (m) { return m.id === S.map; })[0];
    S.mapName = d ? d.name : 'UNKNOWN';
    document.getElementById('h-map').textContent = '#' + S.map + ' · ' + S.mapName;
  }

  // ---------- actions ------------------------------------------------------
  function tryPlace(x, y, m) {
    if (!S.ready) return;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    var dx = x - S.x, dy = y - S.y;
    if (dx * dx + dy * dy > S.reach * S.reach) return toast('OUT OF REACH — ' + S.reach + ' TILES MAX');
    var cur = S.edits.get(tk(x, y));
    if (cur && cur.owner !== S.key) return toast('THAT LAND IS CLAIMED. NOT YOURS.');
    if (m !== RELEASE && S.energy < 1) return toast('NO WILL LEFT');
    var k = tk(x, y);
    if (m === RELEASE) { S.edits.delete(k); S.lamps.delete(k); }
    else {
      S.edits.set(k, { m: m, owner: S.key }); setLamp(k, m);
      S.energy -= 1; S.swingT = 0.18; S.swingA = Math.atan2(dy, dx);
      puff(x + 0.5, y + 0.5, '#d8d2bd', 5, 1.6);
    }
    send({ t: 'set', x: x, y: y, m: m });
    sfx(m === RELEASE ? 'release' : 'place');
  }

  /** One button, context-sensitive: strike a beast, else harvest, else build. */
  function contextAction(x, y) {
    var mon = monAt(x, y);
    if (mon) {
      var d = Math.hypot(mon.x - S.x, mon.y - S.y);
      if (d > S.attackRange + 1) return toast('TOO FAR TO STRIKE');
      faceTowards(mon.rx - S.x, mon.ry - S.y);
      startSwing(Math.atan2(mon.ry - S.y, mon.rx - S.x));
      S.target = mon; S.targetUntil = Date.now() + 4000;
      send({ t: 'attack', id: mon.id });
      sfx('attack');
      return;
    }
    var dr = S.drops.get(nkN(x, y));
    if (dr) {
      var ddx = x - S.x, ddy = y - S.y;
      if (ddx * ddx + ddy * ddy > S.reach * S.reach) return toast('OUT OF REACH — ' + S.reach + ' TILES MAX');
      faceTowards(ddx, ddy);
      send({ t: 'pickup', x: x, y: y });
      return;
    }
    var st = S.structures.get(nkN(x, y));
    if (st) {
      var sdx = x - S.x, sdy = y - S.y;
      if (sdx * sdx + sdy * sdy > S.reach * S.reach) return toast('OUT OF REACH — ' + S.reach + ' TILES MAX');
      if (st.owner !== S.key) return toast(st.kind.toUpperCase() + ' — NOT YOURS');
      faceTowards(sdx, sdy);
      send({ t: 'collect-structure', x: x, y: y });
      return;
    }
    if (S.placingStructure) {
      var pdx = x - S.x, pdy = y - S.y;
      var kind = S.placingStructure;
      S.placingStructure = null;
      if (pdx * pdx + pdy * pdy > S.reach * S.reach) return toast('OUT OF REACH — ' + S.reach + ' TILES MAX');
      var owned = S.edits.get(tk(x, y));
      if (!owned || owned.owner !== S.key) return toast('NEEDS YOUR OWN CLAIMED LAND');
      faceTowards(pdx, pdy);
      send({ t: 'build-structure', x: x, y: y, kind: kind });
      return;
    }
    var nd = S.nodes.get(nkN(x, y));
    if (nd && nd.state === 1) {
      var dx = x - S.x, dy = y - S.y;
      if (dx * dx + dy * dy > S.reach * S.reach) return toast('OUT OF REACH');
      faceTowards(dx, dy);
      S.swingT = SWING * 0.8; S.swingA = Math.atan2(dy, dx);
      send({ t: 'harvest', x: x, y: y });
      return;
    }
    if (nd && nd.state === 0) {
      var left = Math.max(0, Math.ceil((nd.until - Date.now()) / 1000));
      return toast('REGROWING — ' + left + 's');
    }
    // Harvest-first: empty ground does not place until the player has harvested once.
    if (!S.canBuild) {
      return toast('LOOK FOR TREES AND SEAMS — LMB HARVESTS');
    }
    tryPlace(x, y, PALETTE[S.sel]);
  }

  function monAt(x, y) {
    var best = null, bd = 1.35, cx = x + 0.5, cy = y + 0.5;
    S.mons.forEach(function (m) {
      var dx = m.rx - cx, dy = m.ry - cy, d2 = dx * dx + dy * dy;
      if (d2 < bd * bd) { bd = Math.sqrt(d2); best = m; }
    });
    return best;
  }

  // ---------- input --------------------------------------------------------
  var keys = {};
  // A name typed at the gate must not drive the world. Hotkeys listen on window, so
  // without this 'T' in a player name opened the travel overlay and 'M' opened the map —
  // and the player walked off while typing 'wasd'.
  function isTyping(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }
  window.addEventListener('keydown', function (e) {
    if (isTyping(e)) return;
    var k = e.key.toLowerCase();
    keys[k] = true;
    unlockAudio();
    if (k === 'm') { toggleMap(); sfx('ui'); e.preventDefault(); return; }
    if (k === 't') { toggleTravel(); sfx('ui'); e.preventDefault(); return; }
    if (k === 'c') { toggleCraft(); e.preventDefault(); return; }
    if (k === 'i') { toggleIdle(); e.preventDefault(); return; }
    if (k === 'l') { toggleLeaderboard(); sfx('ui'); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (S.mapOpen) toggleMap(); if (S.travelOpen) closeTravel(); if (S.craftOpen) closeCraft(); if (S.idleOpen) closeIdle(); if (S.lbOpen) closeLeaderboard(); return; }
    if (e.key === '+' || e.key === '=') { S.zoom = Math.min(3, S.zoom * 2); e.preventDefault(); return; }
    if (e.key === '-' || e.key === '_') { S.zoom = Math.max(0.5, S.zoom / 2); e.preventDefault(); return; }
    var n = parseInt(e.key, 10);
    if (!isNaN(n)) { var idx = (n === 0) ? 9 : n - 1; if (idx < PALETTE.length) { S.sel = idx; buildHotbar(); } }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  window.addEventListener('blur', function () { keys = {}; });

  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    S.mouse.x = e.clientX - r.left; S.mouse.y = e.clientY - r.top;
  });
  var painting = 0;
  cv.addEventListener('mousedown', function (e) {
    e.preventDefault();
    unlockAudio();
    if (S.mapOpen || S.travelOpen || S.craftOpen || S.lbOpen) return;
    // Act on where this click is, not on where the cursor last was: a click can arrive
    // without a preceding move (programmatic clicks, some touch/pen paths).
    var r = cv.getBoundingClientRect();
    S.mouse.x = e.clientX - r.left; S.mouse.y = e.clientY - r.top;
    painting = (e.button === 2) ? 2 : 1;
    doAction();
  });
  window.addEventListener('mouseup', function () { painting = 0; });
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  cv.addEventListener('wheel', function (e) {
    var r = cv.getBoundingClientRect();
    S.mouse.x = e.clientX - r.left; S.mouse.y = e.clientY - r.top;
    S.sel = (S.sel + (e.deltaY < 0 ? 1 : -1) + PALETTE.length) % PALETTE.length;
    buildHotbar(); e.preventDefault();
  }, { passive: false });

  // ---------- touch (mobile) ----------------------------------------------
  // The desktop is keyboard+mouse. On a phone there is no keyboard, so movement and
  // action get real controls instead of a world you can only look at.
  var TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (TOUCH) document.body.classList.add('touch');

  var stick = document.getElementById('stick'), knob = document.getElementById('knob');
  if (stick) {
    var stickId = null, stickRect = null;

    function stickUpdate(t) {
      var r = stickRect || stick.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var dx = t.clientX - cx, dy = t.clientY - cy;
      var max = r.width / 2 - 12, len = Math.hypot(dx, dy);
      if (len < 9) { S.joy = null; knob.style.transform = 'translate(0,0)'; return; }
      var mag = Math.min(1, len / max);                    // partial push = slower walk
      S.joy = { x: (dx / len) * mag, y: (dy / len) * mag };
      var kx = len > max ? (dx / len) * max : dx, ky = len > max ? (dy / len) * max : dy;
      knob.style.transform = 'translate(' + kx + 'px,' + ky + 'px)';
    }

    stick.addEventListener('touchstart', function (e) {
      e.preventDefault();
      unlockAudio();
      if (stickId !== null) return;                        // first finger owns the stick
      stickId = e.changedTouches[0].identifier;
      stickRect = stick.getBoundingClientRect();
      stickUpdate(e.changedTouches[0]);
    }, { passive: false });

    stick.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === stickId) stickUpdate(e.touches[i]);
    }, { passive: false });

    function stickEnd(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === stickId) {
          stickId = null; stickRect = null; S.joy = null;
          knob.style.transform = 'translate(0,0)';
        }
      }
    }
    stick.addEventListener('touchend', stickEnd);
    stick.addEventListener('touchcancel', stickEnd);
  }

  // Tapping the world acts on the tile under the finger. Holding it gives land back,
  // which is what the right mouse button does on the desktop.
  var tapId = null, tapT0 = 0, tapX = 0, tapY = 0, tapMoved = false, holdFired = false, holdTimer = null;

  cv.addEventListener('touchstart', function (e) {
    unlockAudio();
    if (S.mapOpen || S.travelOpen || S.craftOpen || S.lbOpen) return;                 // overlays handle their own taps
    e.preventDefault();
    if (tapId !== null) return;
    var t = e.changedTouches[0];
    tapId = t.identifier; tapT0 = Date.now(); tapX = t.clientX; tapY = t.clientY;
    tapMoved = false; holdFired = false;
    var r = cv.getBoundingClientRect();
    S.mouse.x = t.clientX - r.left; S.mouse.y = t.clientY - r.top;
    holdTimer = setTimeout(function () {
      holdFired = true;
      var tt = screenToTile(S.mouse.x, S.mouse.y);
      tryPlace(tt.x, tt.y, RELEASE);
      if (navigator.vibrate) navigator.vibrate(25);
    }, 520);
  }, { passive: false });

  cv.addEventListener('touchmove', function (e) {
    e.preventDefault();
    for (var i = 0; i < e.touches.length; i++) {
      var t = e.touches[i];
      if (t.identifier !== tapId) continue;
      if (Math.hypot(t.clientX - tapX, t.clientY - tapY) > 14) { tapMoved = true; clearTimeout(holdTimer); }
      var r = cv.getBoundingClientRect();
      S.mouse.x = t.clientX - r.left; S.mouse.y = t.clientY - r.top;
    }
  }, { passive: false });

  function canvasTapEnd(e) {
    clearTimeout(holdTimer);
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier !== tapId) continue;
      tapId = null;
      if (!tapMoved && !holdFired && Date.now() - tapT0 < 520) doAction();
    }
  }
  cv.addEventListener('touchend', canvasTapEnd);
  cv.addEventListener('touchcancel', canvasTapEnd);

  (function wirePad() {
    function tap(id, fn) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
    }
    tap('pb-map', toggleMap);
    tap('pb-travel', toggleTravel);
    tap('pb-craft', toggleCraft);
    tap('pb-lb', toggleLeaderboard);
    tap('pb-zin', function () { S.zoom = Math.min(3, S.zoom * 2); });
    tap('pb-zout', function () { S.zoom = Math.max(0.5, S.zoom / 2); });
  })();

  var lastPaint = 0;
  function doAction() {
    var t = screenToTile(S.mouse.x, S.mouse.y);
    if (painting === 2) tryPlace(t.x, t.y, RELEASE);
    else contextAction(t.x, t.y);
  }

  function screenToTile(sx, sy) {
    var s = TS * S.zoom;
    return { x: Math.floor((sx - VW / 2) / s + S.cam.x), y: Math.floor((sy - VH / 2) / s + S.cam.y) };
  }

  function faceTowards(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 0.001 && ay < 0.001) return;
    if (ax > ay * 1.6) { S.faceX = dx > 0 ? 1 : -1; S.faceY = 0; }
    else if (ay > ax * 1.6) { S.faceX = 0; S.faceY = dy > 0 ? 1 : -1; }
    else { S.faceX = dx > 0 ? 1 : -1; S.faceY = dy > 0 ? 1 : -1; }
  }
  function startSwing(ang) {
    S.swingT = SWING; S.swingA = ang;
    S.swingDX = Math.cos(ang); S.swingDY = Math.sin(ang);
  }

  // ---------- particles + floating text -----------------------------------
  var SPARKS = [], SPARK_MAX = 180, sparkHead = 0;
  for (var si = 0; si < SPARK_MAX; si++) {
    SPARKS.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, ttl: 1, c: '#fff', sz: 2, drag: 0.9 });
  }
  // tiny debris puff: used for hits, harvests and placement
  function puff(x, y, col, n, spd) {
    for (var i = 0; i < n; i++) {
      var p = SPARKS[sparkHead]; sparkHead = (sparkHead + 1) % SPARK_MAX;
      var a = (i / n) * TAU + rng(sparkHead, i, 17) * 2;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * spd * (0.4 + rng(i, sparkHead, 19) * 0.9);
      p.vy = Math.sin(a) * spd * (0.4 + rng(sparkHead, i, 23) * 0.9) - spd * 0.35;
      p.ttl = 0.32 + rng(i, i * 3, 29) * 0.35;
      p.life = p.ttl; p.c = col; p.sz = 1 + (rng(i, sparkHead, 31) * 1.6);
      p.drag = 0.86;
    }
  }
  // heavier hit: sparks plus a bright core
  function burst(x, y, pal, n, spd) {
    puff(x, y, pal.dark || '#c08a5a', n, spd);
    puff(x, y, pal.light || '#fff0c0', Math.max(3, n >> 1), spd * 1.25);
    puff(x, y, pal.glowc || '#fff8dc', 3, spd * 0.5);
  }

  function float(x, y, text, color, big) {
    S.floats.push({ x: x + 0.5, y: y + 0.2, text: text, color: color, t: 0, big: big | 0, vx: (T.r01(S.floats.length, (x * 7 + y * 13) | 0, 5) - 0.5) * 0.7 });
    if (S.floats.length > 48) S.floats.shift();
  }

  // ---------- HUD ----------------------------------------------------------
  var hotbar = document.getElementById('hotbar');
  var tlPanel = document.getElementById('hud-tl');
  var tgtEl = document.getElementById('h-target'), tgtName = document.getElementById('h-target-name'), tgtBar = document.getElementById('h-target-bar');
  // inventory chips are rebuilt from a reused array — no per-update allocation
  var INV_KEYS = ['wood', 'ore', 'herb', 'crystal'], INV_HTML = [];
  function invChip(r) { INV_HTML.push('<span class="chip">' + r + ' ' + (this[r] || 0) + '</span>'); }

  // ---- first-session progressive disclosure (integrator / quests.js hooks) ----
  // body.onboarding       — no localStorage stratum_onboard_done
  // body.seen-claim-stats — full #hud-tr opacity while still onboarding
  // body.quests-done      — hides #hud-quest; set with completeOnboarding()
  // window.StratumHud.markSeenClaimStats() | completeOnboarding() | setQuest(t,h) | noteAction()
  var ONBOARD_ACTIONS = 12, onboardActions = 0;
  var questTitleEl = document.getElementById('quest-title');
  var questHintEl = document.getElementById('quest-hint');
  if (!localStorage.getItem('stratum_onboard_done')) {
    document.body.classList.add('onboarding');
  } else {
    document.body.classList.add('quests-done');
  }
  if (!window.Quests) {
    if (questTitleEl) questTitleEl.textContent = 'FIRST HARVEST';
    if (questHintEl) questHintEl.textContent = 'Walk to a tree or ore seam and LMB';
  }
  window.StratumHud = {
    markSeenClaimStats: function () { document.body.classList.add('seen-claim-stats'); },
    completeOnboarding: function () {
      localStorage.setItem('stratum_onboard_done', '1');
      document.body.classList.remove('onboarding');
      document.body.classList.add('quests-done');
    },
    setQuest: function (title, hint) {
      if (questTitleEl) questTitleEl.textContent = title || '';
      if (questHintEl) questHintEl.textContent = hint || '';
    },
    noteAction: function () {
      if (!document.body.classList.contains('onboarding')) return;
      onboardActions++;
      if (onboardActions >= ONBOARD_ACTIONS) window.StratumHud.completeOnboarding();
    }
  };

  var achEl = document.getElementById('h-ach');
  function updateAchHud() {
    if (!achEl) return;
    achEl.textContent = S.achUnlocked + ' / 14 earned' + (S.achTitle ? ' · "' + S.achTitle + '"' : '');
  }

  function noteMapVisit(mapId) {
    var id = mapId | 0;
    if (!S.mapsSeen[id]) S.mapsSeen[id] = 1;
  }
  function mapsVisitedCount() {
    var n = 0, k;
    for (k in S.mapsSeen) if (Object.prototype.hasOwnProperty.call(S.mapsSeen, k)) n++;
    // "visit another map" means leaving the starter — count maps beyond the first
    return Math.max(0, n - 1);
  }
  function questStats() {
    return {
      harvests: S.harvests | 0,
      claimed: S.personalClaims | 0,
      kills: S.kills | 0,
      craftOpens: S.craftOpens | 0,
      crafts: S.crafts | 0,
      tools: S.tool | 0,
      maps: mapsVisitedCount(),
      mapsVisited: mapsVisitedCount(),
      level: S.level | 0
    };
  }
  var lastQuestId = '';
  function refreshQuest(announce) {
    if (!window.Quests || !window.StratumHud) return;
    if (document.body.classList.contains('quests-done')) return;
    var stats = questStats();
    if (window.Quests.isComplete(stats)) {
      window.StratumHud.setQuest('THE WORLD IS YOURS', 'Land never resets. Provisions always do.');
      window.StratumHud.completeOnboarding();
      if (announce) toast('FIRST SESSION COMPLETE', true);
      return;
    }
    var active = window.Quests.activeQuest(stats);
    if (!active) return;
    window.StratumHud.setQuest(active.title.toUpperCase(), active.hint);
    if (announce && active.id !== lastQuestId && lastQuestId) {
      toast('NEXT: ' + active.title.toUpperCase(), true);
    }
    lastQuestId = active.id;
  }
  function buildHotbar() {
    var html = '';
    for (var i = 0; i < PALETTE.length; i++) {
      var m = PALETTE[i], c = CLR[m];
      // the tooltip prices the material when the server has taught us the costs.
      // catalog.costs is palette-ordered, exactly like PALETTE, so index i is slot i.
      var price = '';
      if (S.catalog && S.catalog.costs && S.catalog.costs[i]) {
        var ct = costText(S.catalog.costs[i]);
        if (ct !== 'nothing') price = ' — ' + ct;
      }
      html += '<div class="slot' + (i === S.sel ? ' on' : '') + '" data-i="' + i + '" title="' + MATNAME[m] +
        price + '" style="background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')">' +
        '<span class="n">' + (i === 9 ? '0' : String(i + 1)) + '</span></div>';
    }
    hotbar.innerHTML = html;
    document.getElementById('h-sel').textContent = S.canBuild
      ? ('building: ' + MATNAME[PALETTE[S.sel]])
      : 'harvest mode';
    Array.prototype.forEach.call(hotbar.children, function (el) {
      el.addEventListener('click', function () { S.sel = +el.dataset.i; buildHotbar(); });
    });
  }
  var toastEl = document.getElementById('toast'), toastTo = 0;
  function toast(msg, good) {
    toastEl.textContent = msg;
    toastEl.className = 'on' + (good ? ' good' : '');
    clearTimeout(toastTo);
    toastTo = setTimeout(function () { toastEl.className = ''; }, 1900);
  }

  function toggleTravel() {
    S.travelOpen = !S.travelOpen;
    document.getElementById('nodes').classList.toggle('on', S.travelOpen);
    if (S.travelOpen) buildTravel();
  }
  function closeTravel() {
    S.travelOpen = false;
    document.getElementById('nodes').classList.remove('on');
  }
  function buildTravel() {
    var el = document.getElementById('mlist'), html = '';
    for (var i = 0; i < S.maps.length; i++) {
      var m = S.maps[i];
      html += '<div class="mcard" data-id="' + m.id + '"><div class="nm">' + m.name +
        (m.id === S.map ? ' <span class="tier">← YOU ARE HERE</span>' : '') + '</div>' +
        '<div class="tier">TIER ' + m.tier + ' · 1,048,576 TILES</div>' +
        '<div class="ds">' + m.desc + '</div></div>';
    }
    el.innerHTML = html;
    Array.prototype.forEach.call(el.children, function (c) {
      c.addEventListener('click', function () {
        var id = +c.dataset.id;
        if (id === S.map) return closeTravel();
        send({ t: 'travel', map: id });
      });
    });
  }

  // ---------- craft ----------------------------------------------------------
  // The server ships the whole catalogue inside the welcome message (costs, recipes,
  // tool tiers), so this panel renders from S.catalog and never needs economy.js.
  function costText(cost) {
    if (!cost || typeof cost !== 'object') return 'nothing';
    var parts = [];
    for (var k in cost) if (cost[k] > 0) parts.push(cost[k] + ' ' + k);
    return parts.length ? parts.join(' + ') : 'nothing';
  }
  function canPay(cost) {
    if (!cost) return true;
    var inv = S.inv || {};
    for (var k in cost) if ((inv[k] || 0) < cost[k]) return false;
    return true;
  }
  function itemName(id) {
    if (S.catalog && S.catalog.items && S.catalog.items[id]) return S.catalog.items[id].name;
    return String(id).replace(/_/g, ' ');
  }
  function toolName(t) {
    if (S.catalog && S.catalog.tools && S.catalog.tools[t]) return S.catalog.tools[t].name;
    return 'tier ' + t;
  }
  function toggleCraft() {
    if (!S.ready) return;
    S.craftOpen = !S.craftOpen;
    document.getElementById('craft').classList.toggle('on', S.craftOpen);
    if (S.craftOpen) {
      S.craftOpens += 1;
      buildCraft();
      sfx('ui');
      if (window.StratumHud) window.StratumHud.noteAction();
      refreshQuest(true);
    }
  }
  function closeCraft() {
    S.craftOpen = false;
    document.getElementById('craft').classList.remove('on');
  }
  function buildCraft() {
    var list = document.getElementById('craftlist');
    document.getElementById('crafttool').textContent = toolName(S.tool | 0).toUpperCase() + ' TOOLS';
    if (!S.catalog) {
      list.innerHTML = '<div class="mcard"><div class="ds">THE WORLD HAS NOT TAUGHT YOU CRAFT YET.</div></div>';
      return;
    }
    var html = '', i, r;
    var tiers = S.catalog.tools || [];
    var next = (S.tool | 0) + 1;
    if (next < tiers.length) {
      var ok = canPay(tiers[next].cost);
      html += '<div class="mcard" data-toolup="1"><div class="nm">' + tiers[next].name.toUpperCase() + ' TOOLS</div>' +
        '<div class="tier">HARVEST MORE PER SWING</div>' +
        '<div class="cost ' + (ok ? 'can' : 'cant') + '">' + costText(tiers[next].cost) + '</div></div>';
    } else if (tiers.length) {
      html += '<div class="mcard locked"><div class="nm">' + tiers[tiers.length - 1].name.toUpperCase() + ' TOOLS</div>' +
        '<div class="tier">THE BEST THERE IS</div></div>';
    }
    var recs = S.catalog.recipes || [];
    var onboardCraft = document.body.classList.contains('onboarding') && (S.tool | 0) === 0;
    for (i = 0; i < recs.length; i++) {
      r = recs[i];
      var locked = r.tier > (S.tool | 0);
      // first-session craft: hide locked higher-tier recipes so the next step is obvious
      if (onboardCraft && locked) continue;
      var afford = !locked && canPay(r.inputs);
      html += '<div class="mcard' + (locked ? ' locked' : '') + '" data-recipe="' + r.id + '">' +
        '<div class="nm">' + itemName(r.output.item).toUpperCase() +
        (locked ? ' <span class="tier">— NEEDS ' + toolName(r.tier).toUpperCase() + '</span>' : '') + '</div>' +
        '<div class="cost ' + (afford ? 'can' : 'cant') + '">' + costText(r.inputs) + '</div></div>';
    }
    list.innerHTML = html;
    Array.prototype.forEach.call(list.children, function (el) {
      el.addEventListener('click', function () {
        unlockAudio();
        if (el.dataset.toolup) send({ t: 'toolup' });
        else if (el.dataset.recipe) send({ t: 'craft', id: el.dataset.recipe });
      });
    });
  }

  // ---------- idle structures -------------------------------------------------
  // Same catalog-driven pattern as craft: the server ships every structure's cost/
  // tier/rate/capacity in S.catalog.structures, so picking one just arms the next LMB
  // click (contextAction sends 'build-structure' at whatever tile gets clicked).
  function toggleIdle() {
    if (!S.ready) return;
    S.idleOpen = !S.idleOpen;
    document.getElementById('idle').classList.toggle('on', S.idleOpen);
    if (S.idleOpen) { buildIdleList(); sfx('ui'); if (window.StratumHud) window.StratumHud.noteAction(); }
  }
  function closeIdle() {
    S.idleOpen = false;
    document.getElementById('idle').classList.remove('on');
  }
  function buildIdleList() {
    var list = document.getElementById('idlelist');
    var defs = (S.catalog && S.catalog.structures) || [];
    if (!defs.length) { list.innerHTML = '<div class="mcard"><div class="ds">NO STRUCTURES KNOWN YET.</div></div>'; return; }
    var html = '';
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var locked = d.tier > (S.tool | 0);
      var afford = !locked && canPay(d.cost);
      var perMin = Math.round(d.ratePerMs * 60000 * 10) / 10;
      html += '<div class="mcard' + (locked ? ' locked' : '') + '" data-kind="' + d.id + '">' +
        '<div class="nm">' + d.name.toUpperCase() +
        (locked ? ' <span class="tier">— NEEDS TIER ' + d.tier + ' TOOLS</span>' : '') + '</div>' +
        '<div class="tier">MAKES ' + d.produces.toUpperCase() + ' — ~' + perMin + '/min, CAPS AT ' + d.capacity + '</div>' +
        '<div class="cost ' + (afford ? 'can' : 'cant') + '">' + costText(d.cost) + '</div></div>';
    }
    list.innerHTML = html;
    Array.prototype.forEach.call(list.children, function (el) {
      el.addEventListener('click', function () {
        if (el.classList.contains('locked')) return;
        unlockAudio();
        S.placingStructure = el.dataset.kind;
        closeIdle();
        toast('SELECT YOUR OWN CLAIMED LAND — LMB TO BUILD');
      });
    });
  }

  // ---------- leaderboard ---------------------------------------------------
  // Read-only view of /api/leaderboard: a plain fetch, no wire protocol of its own —
  // the game's core stat ("% of world claimed") had no comparative view until this.
  function toggleLeaderboard() {
    if (!S.ready) return;
    S.lbOpen = !S.lbOpen;
    document.getElementById('leaderboard').classList.toggle('on', S.lbOpen);
    if (S.lbOpen) { buildLeaderboard(); if (window.StratumHud) window.StratumHud.noteAction(); }
  }
  function closeLeaderboard() {
    S.lbOpen = false;
    document.getElementById('leaderboard').classList.remove('on');
  }
  function lbRows(list, valKey, extra) {
    if (!list || !list.length) return '<div class="lbempty">NOBODY YET.</div>';
    var myTag = T.keyTag(S.key), html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i], mine = myTag && r.tag === myTag;
      var v = r[valKey] + (extra ? ' ' + extra : '');
      html += '<div class="lbrow' + (mine ? ' me' : '') + '"><span><span class="lbn">' + (i + 1) + '.</span> ' +
        String(r.name || 'WANDERER') + '</span><span class="lbv">' + v + '</span></div>';
    }
    return html;
  }
  function buildLeaderboard() {
    var landEl = document.getElementById('lb-land'), killsEl = document.getElementById('lb-kills'), levelEl = document.getElementById('lb-level');
    fetch('/api/leaderboard').then(function (r) { return r.json(); }).then(function (d) {
      landEl.innerHTML = lbRows(d.land, 'count');
      killsEl.innerHTML = lbRows(d.kills, 'kills');
      levelEl.innerHTML = lbRows(d.level, 'level');
    }).catch(function () {
      landEl.innerHTML = killsEl.innerHTML = levelEl.innerHTML = '<div class="lbempty">COULD NOT REACH THE WORLD.</div>';
    });
  }

  // ---------- map artifact -------------------------------------------------
  var mapCv = document.getElementById('mapcv'), mapCtx = mapCv.getContext('2d');
  var mapBase = null, mapBaseFor = -1;
  function buildMapBase(mapId) {
    var G = 256, grid = T.sampleGrid(mapId, G, G);
    var img = mapCtx.createImageData(G, G);
    for (var i = 0; i < G * G; i++) {
      var c = CLR[grid[i]] || CLR[0], k = i * 4;
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
    }
    var oc = document.createElement('canvas');
    oc.width = G; oc.height = G;
    oc.getContext('2d').putImageData(img, 0, 0);
    mapBase = oc; mapBaseFor = mapId;
  }
  function drawMap() {
    var G = 256;
    if (mapBaseFor !== S.map) buildMapBase(S.map);
    mapCtx.imageSmoothingEnabled = false;
    mapCtx.drawImage(mapBase, 0, 0, G, G);
    if (S.mapDensity) {
      var img = mapCtx.getImageData(0, 0, G, G);
      for (var i = 0; i < G * G; i++) {
        var d = S.mapDensity[i];
        if (!d) continue;
        var a = Math.min(0.92, 0.22 + d * 0.16), k = i * 4;
        img.data[k] = img.data[k] * (1 - a) + 255 * a;
        img.data[k + 1] = img.data[k + 1] * (1 - a) + 222 * a;
        img.data[k + 2] = img.data[k + 2] * (1 - a) + 150 * a;
      }
      mapCtx.putImageData(img, 0, 0);
    }
    mapCtx.fillStyle = '#fff';
    mapCtx.fillRect((S.x / W) * G - 1, (S.y / H) * G - 1, 3, 3);
    document.getElementById('mapcap').innerHTML =
      '#' + S.map + ' ' + S.mapName + ' — WORLD CLAIMED <b>' + ((S.claimed / S.total) * 100).toFixed(4) + '%</b><br>' +
      S.claimed.toLocaleString() + ' / ' + S.total.toLocaleString() + ' tiles · ' +
      (S.total - S.claimed).toLocaleString() + ' remain · [M] close';
  }
  function toggleMap() {
    S.mapOpen = !S.mapOpen;
    document.getElementById('map').classList.toggle('on', S.mapOpen);
    if (S.mapOpen) { send({ t: 'map' }); drawMap(); }
  }

  // ---------- loop ---------------------------------------------------------
  var last = performance.now();
  function frame(now) {
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    S.dt = dt;

    if (S.ready) {
      if (!S.mapOpen && !S.travelOpen && !S.craftOpen) {
        var sp = 9.5 * dt, vx = 0, vy = 0;
        if (keys['a'] || keys['arrowleft']) vx -= 1;
        if (keys['d'] || keys['arrowright']) vx += 1;
        if (keys['w'] || keys['arrowup']) vy -= 1;
        if (keys['s'] || keys['arrowdown']) vy += 1;
        if (S.joy) { vx += S.joy.x; vy += S.joy.y; }
        var L = Math.hypot(vx, vy);
        if (L > 1) { vx /= L; vy /= L; L = 1; }          // analog: a half-pushed stick walks at half speed
        if (L > 0.04) {
          var nx = Math.max(1, Math.min(W - 2, S.x + vx * sp));
          var ny = Math.max(1, Math.min(H - 2, S.y + vy * sp));
          if (tileAt(Math.round(nx), Math.round(ny)) !== 0) { S.x = nx; S.y = ny; }
          faceTowards(vx, vy);
          S.moving = 1;
          S.walk += dt * 10.5 * (0.55 + L);
        } else {
          S.moving = 0;
        }
      } else {
        S.moving = 0;
      }
      S.cam.x += (S.x - S.cam.x) * Math.min(1, dt * 8);
      S.cam.y += (S.y - S.cam.y) * Math.min(1, dt * 8);
      if (S.energy < S.energyMax) S.energy = Math.min(S.energyMax, S.energy + dt * 12.5);

      moveAcc += dt;
      if (moveAcc > 0.08) {
        moveAcc = 0;
        send({ t: 'move', x: Math.round(S.x), y: Math.round(S.y) });
        var ck = T.chunkOf(S.x) + ',' + T.chunkOf(S.y);
        if (ck !== S.lastViewCk) { S.lastViewCk = ck; send({ t: 'view', x: Math.round(S.x), y: Math.round(S.y) }); }
      }
      if (painting && !S.mapOpen && !S.travelOpen && (now - lastPaint) > 60) { lastPaint = now; doAction(); }
    }

    // presentation clocks — decaying, no allocation
    if (S.swingT >= 0) { S.swingT -= dt; if (S.swingT < -0.001) S.swingT = -1; }
    if (S.shake > 0) { S.shake -= dt * 2.4; if (S.shake < 0) S.shake = 0; }
    if (S.hurt > 0) { S.hurt -= dt * 2.0; if (S.hurt < 0) S.hurt = 0; }
    if (S.death >= 0) { S.death += dt; if (S.death > 2.0) S.death = -1; }
    S.mons.forEach(tickSwing);

    render(now, dt);
    hud(now);
    requestAnimationFrame(frame);
  }

  // ---------- render ------------------------------------------------------
  var SB = null;                     // visible tile scratch buffer
  var zlist = [], zpool = [], zi = 0;
  var V_OX = 0, V_OY = 0, V_S = TS;   // frame globals for the sprite helpers
  var V_NOW = 0;
  var Z_X0 = 0, Z_X1 = 0, Z_Y0 = 0, Z_Y1 = 0;   // visible tile bounds for the entity pass
  var nodeN = 0;
  var SELF = { x: 0, y: 0 };
  function znew(y, k, r) {
    if (zi === zpool.length) zpool.push({ y: 0, k: 0, r: null });
    var e = zpool[zi++];
    e.y = y; e.k = k; e.r = r;
    zlist.push(e);
  }
  function cmpZ(a, b) { return a.y - b.y; }

  // Entity collection and the lamp pass are hoisted, not inline closures: the frame loop
  // must not allocate a function per pass per frame.
  function takeNode(nd) {
    if (nodeN > 520) return;                           // a screenful never needs more
    if (nd.x < Z_X0 || nd.x > Z_X1 || nd.y < Z_Y0 || nd.y > Z_Y1) return;
    nodeN++;
    znew(nd.y + 0.5, 1, nd);
  }
  function takeDrop(dr) {
    if (dr.x < Z_X0 || dr.x > Z_X1 || dr.y < Z_Y0 || dr.y > Z_Y1) return;
    znew(dr.y + 0.5, 5, dr);
  }
  function takeMon(m) {
    var tx = m.x - m.rx, ty = m.y - m.ry, klerp = Math.min(1, S.dt * 14);
    m.rx += tx * klerp; m.ry += ty * klerp;
    if (Math.abs(tx) > 0.05 || Math.abs(ty) > 0.05) {
      if (Math.abs(tx) > Math.abs(ty)) { m.faceX = tx > 0 ? 1 : -1; m.faceY = 0; }
      else { m.faceX = 0; m.faceY = ty > 0 ? 1 : -1; }
      m.walk += S.dt * (m.mode === 1 ? 13 : 9);        // mode 1 = chasing
    }
    if (m.rx < Z_X0 - 2 || m.rx > Z_X1 + 2 || m.ry < Z_Y0 - 2 || m.ry > Z_Y1 + 2) return;
    znew(m.ry, 2, m);
  }
  function takeRemote(p) {
    var dx = p.x - p.lx, dy = p.y - p.ly, kl = Math.min(1, S.dt * 12);
    p.rx += (p.x - p.rx) * kl; p.ry += (p.y - p.ry) * kl;
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
      p.moving = 1; p.walk += S.dt * 10;
      if (Math.abs(dx) > Math.abs(dy)) { p.faceX = dx > 0 ? 1 : -1; p.faceY = 0; }
      else { p.faceX = 0; p.faceY = dy > 0 ? 1 : -1; }
    } else p.moving = 0;
    p.lx = p.x; p.ly = p.y;
    if (p.rx < Z_X0 - 3 || p.rx > Z_X1 + 3 || p.ry < Z_Y0 - 3 || p.ry > Z_Y1 + 3) return;
    znew(p.ry, 3, p);
  }
  function lampPass(k) {
    var lx = k % W, ly = (k / W) | 0;
    if (lx < Z_X0 - 3 || lx > Z_X1 + 3 || ly < Z_Y0 - 3 || ly > Z_Y1 + 3) return;
    var gx = V_OX + (lx + 0.5) * V_S, gy = V_OY + (ly + 0.35) * V_S, gsz = V_S * 4.6;
    ctx.globalAlpha = 0.55 + 0.06 * Math.sin(V_NOW * 0.004 + lx);
    ctx.drawImage(GLOW_LAMP, gx - gsz / 2, gy - gsz / 2, gsz, gsz);
  }
  function tickSwing(m) { if (m.sw > 0) { m.sw -= S.dt; if (m.sw < 0) m.sw = 0; } }

  function ell(x, y, rx, ry, col) {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
  }
  function rct(x, y, w, h, col) {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }
  var OUTL = 'rgba(9,11,15,.92)';

  function render(now, dt) {
    var s = TS * S.zoom, cw = VW, ch = VH;
    V_S = s;
    var shx = 0, shy = 0;
    if (S.shake > 0.01) {
      var sm = S.shake * 5.5;
      shx = Math.sin(now * 0.062) * sm;
      shy = Math.cos(now * 0.081) * sm;
    }
    var ox = cw / 2 - S.cam.x * s + shx, oy = ch / 2 - S.cam.y * s + shy;
    V_OX = ox; V_OY = oy; V_NOW = now;

    var x0 = Math.floor(S.cam.x - cw / 2 / s) - 1, x1 = Math.ceil(S.cam.x + cw / 2 / s) + 1;
    var y0 = Math.floor(S.cam.y - ch / 2 / s) - 1, y1 = Math.ceil(S.cam.y + ch / 2 / s) + 1;
    Z_X0 = x0; Z_X1 = x1; Z_Y0 = y0; Z_Y1 = y1;

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;

    var gw = x1 - x0 + 3, gh = y1 - y0 + 3;
    if (!SB || SB.length < gw * gh || SB.gw !== gw) { SB = new Uint8Array(gw * gh); SB.gw = gw; SB.gh = gh; }
    var i, j, row, ty;
    for (j = 0; j < gh; j++) {
      ty = y0 - 1 + j; row = j * gw;
      for (i = 0; i < gw; i++) SB[row + i] = tileAt(x0 - 1 + i, ty);
    }

    var wt = (now / 170) | 0;
    var waveA = Math.sin(now * 0.0016);
    for (j = 1; j < gh - 1; j++) {
      ty = y0 + j - 1;
      if (ty < 0 || ty >= H) continue;
      var yy = Math.round(oy + ty * s);
      row = j * gw;
      for (i = 1; i < gw - 1; i++) {
        var tx = x0 + i - 1;
        if (tx < 0 || tx >= W) continue;
        var si = row + i, mat = SB[si], xx = Math.round(ox + tx * s);
        var diff = 0;
        var nN = SB[si - gw], nE = SB[si + 1], nS = SB[si + gw], nW = SB[si - 1];
        if (nN !== mat) diff |= 1;
        if (nE !== mat) diff |= 2;
        if (nS !== mat) diff |= 4;
        if (nW !== mat) diff |= 8;
        var sig = diff;
        if ((diff & 3) === 3) sig |= 16;
        if ((diff & 6) === 6) sig |= 32;
        if ((diff & 12) === 12) sig |= 64;
        if ((diff & 9) === 9) sig |= 128;
        ctx.drawImage(composite(mat, variantAt(tx, ty), sig), xx, yy, s, s);

        if (mat === WATER) {
          // animated shimmer, phase derived from position so the sea ripples in waves
          ctx.globalAlpha = 0.30 + 0.24 * Math.sin(now * 0.0014 + tx * 0.6 + ty * 0.45);
          ctx.drawImage(SHIM[(tx * 7 + ty * 13 + wt) & 7], xx, yy, s, s);
          ctx.globalAlpha = 1;
          var fa = 0.34 + 0.28 * (Math.sin(now * 0.002 + tx * 0.8 + ty * 0.5) * 0.5 + 0.5);
          if (nN > 0 && nN !== WATER) { ctx.globalAlpha = fa; ctx.drawImage(FOAM[0], xx, yy, s, s); ctx.globalAlpha = 1; }
          if (nE > 0 && nE !== WATER) { ctx.globalAlpha = fa; ctx.drawImage(FOAM[1], xx, yy, s, s); ctx.globalAlpha = 1; }
          if (nS > 0 && nS !== WATER) { ctx.globalAlpha = fa; ctx.drawImage(FOAM[2], xx, yy, s, s); ctx.globalAlpha = 1; }
          if (nW > 0 && nW !== WATER) { ctx.globalAlpha = fa; ctx.drawImage(FOAM[3], xx, yy, s, s); ctx.globalAlpha = 1; }
        } else if (mat === SAND) {
          // wet sand on the sea side, with a breathing wet line
          var wa = 0.30 + 0.16 * (Math.sin(now * 0.0019 + tx * 0.7 + ty * 0.4) * 0.5 + 0.5) + waveA * 0.04;
          ctx.globalAlpha = wa;
          if (nN === WATER) ctx.drawImage(WET[0], xx, yy, s, s);
          if (nE === WATER) ctx.drawImage(WET[1], xx, yy, s, s);
          if (nS === WATER) ctx.drawImage(WET[2], xx, yy, s, s);
          if (nW === WATER) ctx.drawImage(WET[3], xx, yy, s, s);
          ctx.globalAlpha = 1;
        }
      }
    }

    // lamp light — a pre-baked glow sprite, additive, no gradient per frame
    if (S.lamps.size) {
      ctx.globalCompositeOperation = 'lighter';
      S.lamps.forEach(lampPass);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- entities, y-sorted so what is in front overlaps what is behind ----
    zi = 0; zlist.length = 0; nodeN = 0;
    S.nodes.forEach(takeNode);
    S.drops.forEach(takeDrop);
    S.mons.forEach(takeMon);
    S.remotes.forEach(takeRemote);
    SELF.x = S.x; SELF.y = S.y;
    znew(S.y, 4, SELF);

    zlist.sort(cmpZ);
    for (var z = 0; z < zlist.length; z++) {
      var e = zlist[z], rr = e.r, kk = e.k;
      var ex, ey;
      if (kk === 4) { ex = ox + S.x * s; ey = oy + S.y * s; }
      else { ex = ox + rr.rx * s; ey = oy + rr.ry * s; }
      if (kk === 1) drawNodeSprite(ex, ey, s, rr, now);
      else if (kk === 5) drawDropSprite(ex, ey, s, now);
      else if (kk === 2) drawMonster(ex, ey, s, rr, now);
      else if (kk === 3) {
        drawAvatar(ex, ey, s, now, rr.body || '#b7c8dc', rr.trim || '#7f93a8', rr.faceX, rr.faceY, rr.walk, rr.moving, -1, 0);
        ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(rr.name, ex + 1, ey - s * 0.95 + 1);
        ctx.fillStyle = '#e8e6df'; ctx.fillText(rr.name, ex, ey - s * 0.95);
      } else {
        drawAvatar(ex, ey, s, now, '#e8e6df', '#c9a55c', S.faceX, S.faceY, S.walk, S.moving, S.swingT, S.swingA);
        if (S.swingT >= 0) drawSlash(ex, ey, s);
      }
    }

    drawSparks(dt);

    // ---- floating combat text ----
    ctx.textAlign = 'center';
    for (var fi = S.floats.length - 1; fi >= 0; fi--) {
      var f = S.floats[fi];
      f.t += dt;
      if (f.t > 1.25) { S.floats.splice(fi, 1); continue; }
      var k = f.t / 1.25;
      var rise = f.t * 0.95 + (1 - Math.min(1, f.t * 7)) * 0.25;
      var fxp = ox + f.x * s + f.vx * f.t * s, fyp = oy + (f.y - rise) * s;
      var size = (f.big === 2 ? 17 : f.big === 1 ? 13.5 : 11) * (1 + (1 - Math.min(1, f.t * 6)) * 0.35);
      ctx.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      if (f.big === 2) {
        ctx.font = '700 ' + size.toFixed(1) + 'px ui-monospace,monospace';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(20,10,4,.85)';
        ctx.strokeText(f.text, fxp, fyp);
        ctx.fillStyle = '#fffdf2'; ctx.fillText(f.text, fxp, fyp);
      } else {
        ctx.font = (f.big ? '700 ' : '') + size.toFixed(1) + 'px ui-monospace,monospace';
        ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillText(f.text, fxp + 1.2, fyp + 1.2);
        ctx.fillStyle = f.color; ctx.fillText(f.text, fxp, fyp);
      }
      ctx.globalAlpha = 1;
    }

    // ---- cursor ----
    if (S.ready && !S.mapOpen && !S.travelOpen) {
      var t = screenToTile(S.mouse.x, S.mouse.y);
      if (t.x >= 0 && t.y >= 0 && t.x < W && t.y < H) {
        var hx = Math.round(ox + t.x * s), hy = Math.round(oy + t.y * s);
        var dxx = t.x - S.x, dyy = t.y - S.y, inReach = (dxx * dxx + dyy * dyy) <= S.reach * S.reach;
        var cur = S.edits.get(tk(t.x, t.y)), mine = !cur || cur.owner === S.key;
        var mon = monAt(t.x, t.y);
        var nd = S.nodes.get(nkN(t.x, t.y));
        if (mon) { S.target = mon; S.targetUntil = Date.now() + 300; }
        var col2 = mon ? (Math.hypot(mon.x - S.x, mon.y - S.y) <= S.attackRange + 1 ? 'rgba(255,120,90,.95)' : 'rgba(230,180,70,.9)')
          : (inReach && (mine || (nd && nd.state === 1))) ? 'rgba(255,255,255,.85)' : 'rgba(230,90,70,.9)';
        ctx.lineWidth = 1; ctx.strokeStyle = col2;
        ctx.strokeRect(hx + .5, hy + .5, s - 1, s - 1);
        ctx.fillStyle = col2;
        ctx.fillRect(hx + 1, hy + 1, 2, 2); ctx.fillRect(hx + s - 3, hy + 1, 2, 2);
        ctx.fillRect(hx + 1, hy + s - 3, 2, 2); ctx.fillRect(hx + s - 3, hy + s - 3, 2, 2);
      }
    }

    // ---- atmosphere, damage flash, death ----
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(VIG_DARK, 0, 0, cw, ch);
    if (S.hurt > 0.01) {
      ctx.globalAlpha = Math.min(1, S.hurt) * 0.9;
      ctx.drawImage(VIG_RED, 0, 0, cw, ch);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;

    if (S.death >= 0) {
      var da = S.death < 0.35 ? S.death / 0.35 : (S.death < 1.25 ? 1 : Math.max(0, 1 - (S.death - 1.25) / 0.75));
      ctx.fillStyle = 'rgba(4,3,7,' + (0.92 * da).toFixed(3) + ')';
      ctx.fillRect(0, 0, cw, ch);
      if (da > 0.25) {
        ctx.globalAlpha = da; ctx.textAlign = 'center';
        ctx.font = '700 ' + Math.max(14, Math.min(26, VW / 20)) + 'px ui-monospace,monospace';
        ctx.fillStyle = '#e0705c';
        ctx.fillText('SLAIN BY ' + S.deathBy, cw / 2, ch * 0.44);
        ctx.font = '11px ui-monospace,monospace';
        ctx.fillStyle = 'rgba(200,190,170,.9)';
        ctx.fillText('RETURNED TO THE SHORE', cw / 2, ch * 0.44 + 26);
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawSparks(dt) {
    var s = V_S, ox = V_OX, oy = V_OY;
    for (var i = 0; i < SPARK_MAX; i++) {
      var p = SPARKS[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.life = 0; continue; }
      p.vx *= p.drag; p.vy = p.vy * p.drag + 2.6 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      var al = p.life / p.ttl;
      ctx.globalAlpha = al > 1 ? 1 : al;
      ctx.fillStyle = p.c;
      var sz = Math.max(1, p.sz * (0.35 + al));
      ctx.fillRect(Math.round(ox + p.x * s - sz / 2), Math.round(oy + p.y * s - sz / 2), Math.round(sz), Math.round(sz));
    }
    ctx.globalAlpha = 1;
  }

  // ---------- death drops (src/drops.js) -----------------------------------
  // Deliberately minimal: a pulsing gold dot marks a loot cache. It is not the focus.
  function drawDropSprite(x, y, s, now) {
    var pulse = 0.72 + 0.22 * Math.sin(now * 0.006);
    var r = s * 0.16 * pulse;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#f2c94c';
    ctx.beginPath(); ctx.arc(x, y - s * 0.08, r * 1.8, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#f2c94c';
    ctx.beginPath(); ctx.arc(x, y - s * 0.08, r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#8a5a1c';
    ctx.beginPath(); ctx.arc(x, y - s * 0.08, r * 0.4, 0, TAU); ctx.fill();
  }

  // ---------- node sprites in the world -----------------------------------
  function drawNodeSprite(x, y, s, nd, now) {
    var alive = nd.state === 1;
    var arr = NODESPR[nd.kind];
    if (!arr) return;
    var vi = T.hash2(nd.x, nd.y, 7) % arr.length;
    var spr2 = arr[vi];
    var sway = alive ? Math.sin(now * 0.0012 + nd.x * 0.7 + nd.y * 0.3) * s * 0.012 : 0;
    ctx.globalAlpha = alive ? 1 : 0.3;
    if (nd.kind === 4 && alive) {                        // crystal glow, additive
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(GLOW_CRYS, x - s * 1.1, y - s * 1.1, s * 2.2, s * 2.2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(spr2, Math.round(x + sway), Math.round(y), Math.round(s), Math.round(s));
    if (nd.kind === 4 && alive) {                        // soft twinkle on top
      ctx.globalAlpha = 0.18 + 0.16 * Math.sin(now * 0.004 + nd.x);
      ctx.drawImage(GLOW_CRYS, x - s * 0.6, y - s * 0.4, s * 1.2, s * 1.2);
    }
    ctx.globalAlpha = 1;
    if (!alive) {   // regrowth countdown on the tile itself
      var left = Math.max(0, Math.ceil((nd.until - Date.now()) / 1000));
      if (left > 0 && s >= 13) {
        ctx.font = Math.max(7, s * 0.42) + 'px ui-monospace,monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(left + 's', x + s * 0.5 + 1, y + s * 0.9 + 1);
        ctx.fillStyle = '#cbbf9a'; ctx.fillText(left + 's', x + s * 0.5, y + s * 0.9);
      }
    }
  }

  // ---------- creatures ---------------------------------------------------
  // Every form is drawn from the same primitives (dark silhouette + coloured masses +
  // eyes) so they read as one world, but the silhouettes are deliberately different:
  // a blob is wide and soft, a brute is top-heavy, a swarm is many, a wisp floats.
  var BOB2 = 0;                                        // 2-frame idle bob, set per creature
  function frame2(now, seed) {
    return (Math.floor(now / 250 + seed * 0.37) & 1) ? 1 : 0;
  }

  function drawMonster(x, y, s, m, now) {
    var f2 = frame2(now, m.id), pal = m.pal;
    BOB2 = f2;
    // lunge toward whatever it is attacking
    var lx = 0, ly = 0;
    if (m.sw > 0) {
      var push = Math.sin((1 - m.sw / (SWING * 1.2)) * Math.PI) * s * 0.2;
      lx = m.swx * push; ly = m.swy * push;
    }
    // walking sway
    var walk = Math.sin(m.walk) * (m.faceX || m.faceY ? 1 : 0);
    // combat telemetry: phase 1 = winding up (rock back), phase 2 = recovering (follow through)
    var lean = 0;
    if (m.phase === 1) lean = -s * 0.055;
    else if (m.phase === 2) lean = s * 0.06;
    var bx = x + lx + (m.faceX || 0) * lean, by = y + ly + (m.faceY || 0) * lean;
    var hurt = (Date.now() - m.hit) < 170;
    var legLift = (m.sw > 0 ? 0 : f2) * s * 0.03;

    // ground shadow (wisps get almost none — they float)
    if (m.form !== 'wisp') ell(bx, by + s * 0.32, s * 0.26, s * 0.1, 'rgba(0,0,0,.34)');

    // a telegraph under a creature that is about to strike
    if (m.phase === 1) {
      var gp = 0.5 + 0.5 * Math.sin(now * 0.02);
      var gs = s * (1.5 + gp * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.28 + gp * 0.34;
      ctx.drawImage(GLOW_WARN, bx - gs / 2, by - s * 0.3 - gs / 2, gs, gs);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    switch (m.form) {
      case 'blob': formBlob(bx, by, s, pal, f2); break;
      case 'brute': formBrute(bx, by, s, pal, f2, walk, legLift); break;
      case 'spitter': formSpitter(bx, by, s, pal, f2, walk); break;
      case 'swarm': formSwarm(bx, by, s, pal, now, m.id); break;
      case 'tank': formTank(bx, by, s, pal, f2, legLift); break;
      case 'wisp': formWisp(bx, by, s, pal, now, m.id); break;
      case 'pack': formPack(bx, by, s, pal, f2, walk); break;
      case 'skirmisher': default: formSkirmisher(bx, by, s, pal, f2, walk, legLift); break;
    }
    if (hurt) {                                        // white flash on the whole mass
      ctx.globalAlpha = 0.42;
      ell(bx, by - s * 0.18, s * 0.34, s * 0.3, '#fff2e2');
      ctx.globalAlpha = 1;
    }
    // health bar only once it is wounded
    if (m.hp < m.maxHp) {
      var bw = Math.max(10, s * 0.8);
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(Math.round(bx - bw / 2), Math.round(by - s * 0.72), Math.round(bw), 3);
      ctx.fillStyle = m.hp / m.maxHp > 0.4 ? '#bf6a4a' : '#d0402c';
      ctx.fillRect(Math.round(bx - bw / 2), Math.round(by - s * 0.72), Math.round(bw * Math.max(0, m.hp / m.maxHp)), 3);
    }
  }

  function eyes(x, y, w, h, fx, col) {
    var off = fx * w * 0.12;
    rct(x - w * 0.3 + off, y, w * 0.18, h, col);
    rct(x + w * 0.12 + off, y, w * 0.18, h, col);
  }

  function formBlob(x, y, s, pal, f2) {
    var w = s * 0.34, h = s * 0.28;
    var sq = f2 ? 1.07 : 0.93;
    ell(x, y - h * 0.15, w + s * 0.045, h * sq + s * 0.045, OUTL);
    ell(x, y - h * 0.15, w, h * sq, pal.body);
    ell(x - w * 0.5, y + h * 0.2, w * 0.36, h * 0.34, pal.body);
    ell(x + w * 0.52, y + h * 0.16, w * 0.3, h * 0.28, pal.body);
    ell(x - w * 0.26, y - h * (f2 ? 0.55 : 0.45), w * 0.42, h * 0.3, pal.light);
    ell(x + w * 0.3, y + h * (f2 ? 0.3 : 0.22), w * 0.24, h * 0.18, pal.dark);
    eyes(x, y - h * 0.3, w * 1.1, s * 0.09, 0, '#f6f2e4');
    eyes(x, y - h * 0.28, w * 1.1, s * 0.05, 0, '#16171d');
  }

  function formBrute(x, y, s, pal, f2, walk, legs) {
    var w = s * 0.46, h = s * 0.52;
    rct(x - w * 0.5 - 1, y - h - 1, w + 2, h * 0.86 + 2, OUTL);
    rct(x - w * 0.5 - 1, y + h * 0.28 - 1, w * 0.4 + 2, h * 0.3 + 2, OUTL);
    // heavy legs
    rct(x - w * 0.42, y + h * 0.24 - legs, w * 0.3, h * 0.3, pal.dark);
    rct(x + w * 0.14, y + h * 0.24 + legs, w * 0.3, h * 0.3, pal.dark);
    // torso, hunched
    rct(x - w * 0.44, y - h * 0.8, w * 0.88, h * 0.62, pal.body);
    rct(x - w * 0.44, y - h * 0.8, w * 0.88, h * 0.12, pal.light);
    // shoulders
    rct(x - w * 0.6, y - h * 0.78, w * 0.26, h * 0.4, pal.shade);
    rct(x + w * 0.34, y - h * 0.78, w * 0.26, h * 0.4, pal.shade);
    // small head, low
    rct(x - w * 0.22, y - h * 0.98, w * 0.44, h * 0.28, pal.light);
    rct(x - w * 0.16, y - h * 0.92, w * 0.32, h * 0.1, '#16171d');
    rct(x - w * 0.1, y - h * 0.94, w * 0.06, h * 0.06, '#ffb066');
    rct(x + w * 0.05, y - h * 0.94, w * 0.06, h * 0.06, '#ffb066');
    // swinging fists
    var sw = walk * s * 0.05;
    rct(x - w * 0.66, y - h * 0.4 + sw - (f2 ? 0 : s * 0.03), w * 0.22, h * 0.24, pal.dark);
    rct(x + w * 0.44, y - h * 0.4 - sw - (f2 ? s * 0.03 : 0), w * 0.22, h * 0.24, pal.dark);
  }

  function formSpitter(x, y, s, pal, f2, walk) {
    var w = s * 0.4, h = s * 0.38;
    // sac behind
    ell(x - w * 0.34, y - h * 0.5, w * 0.36, h * 0.44, OUTL);
    ell(x - w * 0.34, y - h * 0.5, w * 0.3, h * 0.38, pal.light);
    // body
    ell(x, y - h * 0.42, w * 0.42 + s * 0.04, h * 0.4 + s * 0.04, OUTL);
    ell(x, y - h * 0.42 + (f2 ? s * 0.01 : -s * 0.01), w * 0.42, h * 0.4, pal.body);
    ell(x - w * 0.1, y - h * 0.6, w * 0.24, h * 0.18, pal.light);
    // snout / beak
    ctx.fillStyle = pal.dark;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.34, y - h * 0.62);
    ctx.lineTo(x + w * 0.78, y - h * 0.42);
    ctx.lineTo(x + w * 0.34, y - h * 0.26);
    ctx.closePath(); ctx.fill();
    // thin legs
    rct(x - w * 0.3, y + h * 0.0 - (f2 ? s * 0.02 : 0), w * 0.14, h * 0.55, pal.dark);
    rct(x + w * 0.12, y + h * 0.0 - (f2 ? 0 : s * 0.02), w * 0.14, h * 0.55, pal.dark);
    // eyes
    rct(x + w * 0.1, y - h * 0.6, w * 0.16, s * 0.07, '#f6f2e4');
    rct(x + w * 0.14, y - h * 0.59, w * 0.07, s * 0.04, '#16171d');
    // drip
    rct(x + w * 0.5, y - h * 0.2 + walk * s * 0.02, Math.max(1, s * 0.05), Math.max(1, s * 0.09), pal.glowc);
  }

  function formSwarm(x, y, s, pal, now, id) {
    var n = 5, ph = now * 0.004 + id;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU + ph * 0.6;
      var rr = s * (0.12 + 0.06 * ((i % 3) ? 1 : 0));
      var px2 = x + Math.cos(a) * s * 0.2;
      var py2 = y - s * 0.28 + Math.sin(a * 1.3 + ph) * s * 0.1;
      ell(px2, py2, rr + 1, rr * 0.85 + 1, OUTL);
      ell(px2, py2, rr, rr * 0.85, i % 2 ? pal.body : pal.light);
      rct(px2 - rr * 0.4, py2 - rr * 0.2, Math.max(1, rr * 0.5), Math.max(1, rr * 0.4), '#16171d');
    }
    // core body
    ell(x, y - s * 0.1, s * 0.2 + 1, s * 0.18 + 1, OUTL);
    ell(x, y - s * 0.1, s * 0.2, s * 0.18, pal.shade);
    ell(x - s * 0.06, y - s * 0.16, s * 0.1, s * 0.08, pal.light);
    // wings
    ctx.globalAlpha = 0.5;
    ell(x - s * 0.24, y - s * 0.2, s * 0.1, s * 0.05, '#f0f4ff');
    ell(x + s * 0.24, y - s * 0.2, s * 0.1, s * 0.05, '#f0f4ff');
    ctx.globalAlpha = 1;
  }

  function formTank(x, y, s, pal, f2, legs) {
    var w = s * 0.5, h = s * 0.3;
    // shell dome
    rct(x - w * 0.5 - 1, y - h * 1.5 - 1, w + 2, h * 1.7 + 2, OUTL);
    rct(x - w * 0.5, y - h * 1.45, w, h * 1.6, pal.body);
    rct(x - w * 0.5, y - h * 1.45, w, h * 0.34, pal.light);
    rct(x - w * 0.5, y - h * 0.3, w, h * 0.28, pal.dark);
    // plate lines
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fillRect(Math.round(x - w * 0.5), Math.round(y - h * 0.95), Math.round(w), Math.max(1, Math.round(h * 0.09)));
    ctx.fillRect(Math.round(x - w * 0.5), Math.round(y - h * 0.55), Math.round(w), Math.max(1, Math.round(h * 0.09)));
    ctx.fillRect(Math.round(x - w * 0.12), Math.round(y - h * 1.45), Math.max(1, Math.round(h * 0.09)), Math.round(h * 1.15));
    // stumpy legs
    rct(x - w * 0.44, y + h * 0.24 - legs, w * 0.26, h * 0.28, pal.dark);
    rct(x + w * 0.18, y + h * 0.24 + legs, w * 0.26, h * 0.28, pal.dark);
    // head pokes out front
    rct(x + w * 0.34, y - h * 0.78 + (f2 ? s * 0.01 : 0), w * 0.3, h * 0.3, pal.shade);
    rct(x + w * 0.5, y - h * 0.7 - (f2 ? s * 0.01 : 0), w * 0.1, h * 0.12, '#16171d');
    rct(x + w * 0.38, y - h * 0.9, w * 0.12, h * 0.1, pal.glowc);
  }

  function formWisp(x, y, s, pal, now, id) {
    var fl = Math.sin(now * 0.0022 + id) * s * 0.1;
    var cy = y - s * 0.42 + fl;
    // tail — three diminishing puffs
    for (var i = 0; i < 3; i++) {
      var t = (i + 1) / 3.4;
      ctx.globalAlpha = 0.5 - t * 0.14;
      ell(x + Math.sin(now * 0.003 + id + i) * s * 0.06, cy + s * 0.22 * (i + 1), s * (0.14 - i * 0.03), s * (0.16 - i * 0.03), pal.body);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    var gsz = s * 1.7;
    ctx.globalAlpha = 0.5 + 0.12 * Math.sin(now * 0.005 + id);
    ctx.drawImage(GLOW_CRYS, x - gsz / 2, cy - gsz / 2, gsz, gsz);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ell(x, cy, s * 0.2 + 1, s * 0.24 + 1, OUTL);
    ell(x, cy, s * 0.2, s * 0.24, pal.body);
    ell(x - s * 0.05, cy - s * 0.06, s * 0.12, s * 0.13, pal.light);
    rct(x - s * 0.1, cy - s * 0.04, Math.max(1, s * 0.07), Math.max(1, s * 0.07), '#0d0e14');
    rct(x + s * 0.03, cy - s * 0.04, Math.max(1, s * 0.07), Math.max(1, s * 0.07), '#0d0e14');
  }

  function formSkirmisher(x, y, s, pal, f2, walk, legs) {
    var w = s * 0.3, h = s * 0.54;
    rct(x - w * 0.5 - 1, y - h - 1, w + 2, h * 0.8 + 2, OUTL);
    // legs, mid-stride
    rct(x - w * 0.36, y - legs, w * 0.24, h * 0.42, pal.dark);
    rct(x + w * 0.14, y + legs, w * 0.24, h * 0.42, pal.dark);
    // lean body
    rct(x - w * 0.4 + walk * s * 0.02, y - h * 0.86, w * 0.8, h * 0.52, pal.body);
    rct(x - w * 0.4, y - h * 0.86, w * 0.8, h * 0.1, pal.light);
    // arms
    rct(x - w * 0.62, y - h * 0.76 + walk * s * 0.04, w * 0.22, h * 0.36, pal.shade);
    rct(x + w * 0.4, y - h * 0.76 - walk * s * 0.04, w * 0.22, h * 0.36, pal.shade);
    // head + crest
    rct(x - w * 0.3, y - h * 1.24, w * 0.6, h * 0.32, pal.light);
    ctx.fillStyle = pal.dark;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.3, y - h * 1.22);
    ctx.lineTo(x - w * 0.62, y - h * 1.5);
    ctx.lineTo(x - w * 0.18, y - h * 1.34);
    ctx.closePath(); ctx.fill();
    rct(x - w * 0.16, y - h * 1.14, w * 0.14, s * 0.07, '#16171d');
    rct(x + w * 0.04, y - h * 1.14 + (f2 ? s * 0.01 : 0), w * 0.14, s * 0.07, '#16171d');
    // tail
    ctx.strokeStyle = pal.dark; ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.3, y - h * 0.5);
    ctx.lineTo(x - w * 0.9, y - h * 0.3 + Math.sin(walk) * s * 0.08);
    ctx.stroke();
  }

  function formPack(x, y, s, pal, f2, walk) {
    var w = s * 0.52, h = s * 0.24;
    // four legs, alternating
    var l1 = f2 ? s * 0.04 : 0, l2 = f2 ? 0 : s * 0.04;
    rct(x - w * 0.4, y - l1, w * 0.14, s * 0.2, pal.dark);
    rct(x - w * 0.16, y - l2, w * 0.14, s * 0.2, pal.dark);
    rct(x + w * 0.06, y - l1, w * 0.14, s * 0.2, pal.dark);
    rct(x + w * 0.3, y - l2, w * 0.14, s * 0.2, pal.dark);
    // body
    rct(x - w * 0.46 - 1, y - h - 1, w * 0.9 + 2, h + 2, OUTL);
    rct(x - w * 0.46, y - h, w * 0.9, h, pal.body);
    rct(x - w * 0.46, y - h, w * 0.9, h * 0.3, pal.light);
    rct(x - w * 0.2, y - h * 0.8, w * 0.5, h * 0.3, pal.shade);
    // head lowered forward
    rct(x + w * 0.4, y - h * 1.1, w * 0.34, h * 1.1, pal.shade);
    ctx.fillStyle = pal.dark;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.68, y - h * 1.02);
    ctx.lineTo(x + w * 1.0, y - h * 0.62);
    ctx.lineTo(x + w * 0.68, y - h * 0.3);
    ctx.closePath(); ctx.fill();
    // ear + eye
    ctx.fillStyle = pal.light;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.46, y - h * 1.1);
    ctx.lineTo(x + w * 0.54, y - h * 1.55);
    ctx.lineTo(x + w * 0.66, y - h * 1.1);
    ctx.closePath(); ctx.fill();
    rct(x + w * 0.52, y - h * 1.02, Math.max(1, s * 0.06), Math.max(1, s * 0.06), '#ffcf6a');
    // tail
    ctx.strokeStyle = pal.dark; ctx.lineWidth = Math.max(1, s * 0.08);
    ctx.beginPath();
    ctx.moveTo(x - w * 0.44, y - h * 0.8);
    ctx.lineTo(x - w * 0.8, y - h * (f2 ? 1.5 : 1.1));
    ctx.stroke();
  }

  // ---------- avatars (self + remotes) ------------------------------------
  function drawAvatar(x, y, s, now, body, trim, fx, fy, walk, moving, swingT, swingA) {
    var step = moving ? Math.sin(walk) : 0;
    var breath = Math.sin(now / 560) * s * 0.02;
    var bob = moving ? -Math.abs(Math.sin(walk)) * s * 0.05 : breath;
    var lx = 0, ly = 0;
    if (swingT >= 0) {                                  // lunge into the strike
      var k = 1 - swingT / SWING;
      var push = Math.sin(Math.min(1, k) * Math.PI) * s * 0.2;
      lx = (fx || 0) * push * 0.85;
      ly = (fy || 0) * push * 0.85;
    }
    var w = Math.max(6, s * 0.42), h = Math.max(11, s * 0.8);
    var bx = x - w / 2 + lx, by = y - h + s * 0.32 + bob + ly;

    ell(x, y + s * 0.32, w * 0.7, s * 0.14, 'rgba(0,0,0,.34)');

    // legs (alternating), body, arms — chunky pixel blocks
    var sw = step * s * 0.16, asw = step * s * 0.12;
    rct(bx - 1, by + h * 0.62 - 1, w + 2, h * 0.4 + 2, OUTL);
    rct(bx - 1, by - 1, w + 2, h * 0.66 + 2, OUTL);
    rct(bx + w * 0.06 - sw, by + h * 0.62, w * 0.38, h * 0.38, '#3b3428');
    rct(bx + w * 0.56 + sw, by + h * 0.62, w * 0.38, h * 0.38, '#332d22');
    rct(bx, by + h * 0.36, w, h * 0.3, trim);
    rct(bx, by + h * 0.34, w, h * 0.07, 'rgba(255,250,225,.4)');
    rct(bx - w * 0.18, by + h * 0.42 + asw, w * 0.24, h * 0.3, body);
    rct(bx + w * 0.94, by + h * 0.42 - asw, w * 0.24, h * 0.3, body);
    rct(bx + w * 0.12, by + h * 0.04, w * 0.76, h * 0.34, body);
    if (fy < 0 && fx === 0) {                           // facing away: hair, no face
      rct(bx + w * 0.14, by + h * 0.06, w * 0.72, h * 0.16, '#3b3428');
    } else {
      var off = fx * w * 0.14;
      rct(bx + w * 0.28 + off, by + h * 0.17, w * 0.14, h * 0.07, '#241f16');
      rct(bx + w * 0.58 + off, by + h * 0.17, w * 0.14, h * 0.07, '#241f16');
      rct(bx + w * 0.16, by + h * 0.04, w * 0.68, h * 0.06, '#4a4132');
    }
    // the tool in hand, swinging through an arc while the arm is out
    var ax2 = bx + w * 1.06, ay2 = by + h * 0.5;
    if (swingT >= 0) {
      var t = 1 - swingT / SWING;
      ax2 += Math.cos(swingA) * s * 0.22 * t;
      ay2 += Math.sin(swingA) * s * 0.22 * t;
    }
    rct(ax2 - s * 0.03, ay2 - s * 0.08, Math.max(1, s * 0.06), Math.max(2, s * 0.26), '#5a4326');
    rct(ax2 - s * 0.09, ay2 - s * 0.14, Math.max(2, s * 0.2), Math.max(1, s * 0.07), '#b9bec9');
    // gold ring so you never lose yourself in the crowd
    ctx.strokeStyle = 'rgba(201,165,92,.85)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y + s * 0.32, w * 0.8, 0, TAU); ctx.stroke();
  }

  function drawSlash(x, y, s) {
    var k = 1 - S.swingT / SWING;
    if (k < 0 || k > 1) return;
    var a0 = S.swingA - 0.95 + k * 1.9;
    ctx.strokeStyle = 'rgba(255,246,214,' + (0.8 * (1 - k)).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.5, s * (0.16 - 0.08 * k));
    ctx.beginPath();
    ctx.arc(x, y - s * 0.16, s * (0.5 + k * 0.35), a0 - 0.42, a0 + 0.42);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,214,120,' + (0.5 * (1 - k)).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.beginPath();
    ctx.arc(x, y - s * 0.16, s * (0.4 + k * 0.28), a0 - 0.3, a0 + 0.3);
    ctx.stroke();
  }

  // ---------- HUD paint ---------------------------------------------------
  function hud(now) {
    if (now - S.hudAt < 90) return;                      // 11Hz is plenty for text
    S.hudAt = now;
    document.getElementById('h-online').textContent = S.online;
    document.getElementById('h-pos').textContent = Math.round(S.x) + ', ' + Math.round(S.y);
    document.getElementById('h-hp').textContent = Math.round(S.hp) + ' / ' + S.maxHp;
    document.querySelector('#hpbar>div').style.width = Math.max(0, (S.hp / S.maxHp) * 100).toFixed(1) + '%';
    document.getElementById('h-energy').textContent = Math.floor(S.energy);
    document.querySelector('#willbar>div').style.width = ((S.energy / S.energyMax) * 100).toFixed(1) + '%';
    document.getElementById('h-pct').textContent = ((S.claimed / S.total) * 100).toFixed(4) + '%';
    document.getElementById('h-claimed').textContent = S.claimed.toLocaleString() + ' / ' + S.total.toLocaleString();
    document.getElementById('h-remain').textContent = (S.total - S.claimed).toLocaleString();
    // personal claims only — world S.claimed is the map total and would unveil this on day one
    if (S.personalClaims > 0) document.body.classList.add('seen-claim-stats');
    document.getElementById('h-kills').textContent = S.kills;
    document.getElementById('h-atk').textContent = S.atk;
    var inv = S.inv || {};
    INV_HTML.length = 0;
    INV_KEYS.forEach(invChip, inv);
    // crafted gear rides in the same inventory under its item id — chip anything else.
    for (var ck in inv) {
      if (INV_KEYS.indexOf(ck) < 0 && inv[ck] > 0) INV_HTML.push('<span class="chip">' + ck + ' ' + inv[ck] + '</span>');
    }
    document.getElementById('h-inv').innerHTML = INV_HTML.join(' ');
    if (S.volatile) {
      var tooln = toolName(S.tool | 0);
      document.getElementById('h-vol').textContent =
        'beasts ' + S.volatile.monstersLive + ' · regrowing ' + S.volatile.nodesDepleted +
        ' · ' + tooln + ' tools';
    }
    updateAchHud();
    refreshQuest(false);
    if (tlPanel) tlPanel.classList.toggle('hurt', S.hurt > 0.25);
    // target frame
    var tg = S.target;
    var live = tg && S.mons.get(tg.id) && Date.now() < S.targetUntil;
    if (live) {
      tgtEl.classList.add('on');
      tgtName.textContent = (tg.nm || spName(S.map, tg.kind)) + '  ' + Math.max(0, Math.round(tg.hp)) + '/' + tg.maxHp;
      tgtBar.style.width = Math.max(0, (tg.hp / tg.maxHp) * 100).toFixed(1) + '%';
    } else {
      if (tg && !S.mons.get(tg.id)) S.target = null;
      tgtEl.classList.remove('on');
    }
  }

  // ---------- boot --------------------------------------------------------
  function boot() {
    resize();
    buildBasePixels();      // every tile face, then the plain composites
    buildNodeSprites();
    buildWaterSprites();
    GLOW_LAMP = mkGlow('255,214,140', 64);
    GLOW_CRYS = mkGlow('150,230,255', 64);
    GLOW_WARN = mkGlow('255,120,80', 64);
    buildVignette();
    buildMapBase(0);
    var nameIn = document.getElementById('name-in');
    nameIn.value = S.name || '';
    document.getElementById('enter-btn').addEventListener('click', enter);
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') enter(); });
    function enter() {
      var n = (nameIn.value || '').trim().slice(0, 18);
      if (!n) { document.getElementById('gate-err').textContent = 'THE WORLD NEEDS A NAME.'; return; }
      S.name = n;
      localStorage.setItem('stratum_name', n);
      // Dismiss the keyboard and undo the viewport pan it caused. Without this the HUD
      // stays shifted off-screen until the player deliberately scrolls.
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.scrollTo(0, 0);
      setTimeout(resize, 260);
      unlockAudio(); sfx('ui');
      connect();
    }
    requestAnimationFrame(frame);
  }
  boot();
})();
