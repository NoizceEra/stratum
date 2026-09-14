/**
 * STRATUM — browser client.
 *
 * The base world is regenerated locally from each map's seed (free, no network). Only
 * player edits and volatile entities travel over the wire. Rendering is a pre-baked
 * 16x16 tile atlas blitted per visible tile — no image assets, no bundler, no deps.
 */
'use strict';
(function () {
  var T = window.Terrain;
  var TS = 16, W = T.W, H = T.H, CHUNK = T.CHUNK;
  var RELEASE = 0;

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
  // species index -> colour, per map (mirrors the server's SPECIES order)
  var MONCLR = { 0: ['#7fae5a', '#8f6fa0', '#9c8f7a'], 1: ['#c2552f', '#7a3b2a'], 2: ['#4f8fae', '#9c7f5a'] };
  var NODECLR = { 1: '#3f7a34', 2: '#8a7f6a', 3: '#7fc45a', 4: '#8fe4ff' };

  var S = {
    key: localStorage.getItem('stratum_key') || newKey(),
    name: localStorage.getItem('stratum_name') || '',
    map: 0, maps: [], mapName: '',
    x: 0, y: 0, energy: 240, energyMax: 240, reach: 6, attackRange: 3,
    hp: 100, maxHp: 100, atk: 7, kills: 0, inv: { wood: 0, ore: 0, herb: 0, crystal: 0 },
    claimed: 0, total: W * H, online: 0, volatile: null,
    sel: 0, zoom: 1, ready: false,
    cam: { x: 0, y: 0 }, mouse: { x: 0, y: 0 },
    edits: new Map(), baseCache: new Map(),
    nodes: new Map(),          // "x,y" -> {kind, state, until}
    mons: new Map(),           // id -> {kind,x,y,rx,ry,hp,maxHp,hit}
    remotes: new Map(), floats: [],
    lastViewCk: '', mapOpen: false, travelOpen: false, mapDensity: null, lastEnergySync: 0
  };
  localStorage.setItem('stratum_key', S.key);
  function newKey() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function tk(x, y) { return y * W + x; }
  function nkN(x, y) { return x + ',' + y; }

  function baseAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0;
    var cx = T.chunkOf(x), cy = T.chunkOf(y), ck = S.map + ':' + cx + ':' + cy;
    var arr = S.baseCache.get(ck);
    if (!arr) {
      if (S.baseCache.size > 1200) S.baseCache.clear();
      arr = T.buildChunk(S.map, cx, cy);
      S.baseCache.set(ck, arr);
    }
    return arr[(y - cy * CHUNK) * CHUNK + (x - cx * CHUNK)];
  }
  function tileAt(x, y) {
    var e = S.edits.get(tk(x, y));
    return e ? e.m : baseAt(x, y);
  }

  // ---------- tile atlas ---------------------------------------------------
  var atlas = {};
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
  function buildAtlas() {
    for (var m in CLR) {
      var c = CLR[m], variants = [];
      for (var v = 0; v < 4; v++) {
        var cv = document.createElement('canvas');
        cv.width = TS; cv.height = TS;
        var g = cv.getContext('2d');
        var img = g.createImageData(TS, TS);
        for (var y = 0; y < TS; y++) {
          for (var x = 0; x < TS; x++) {
            var h = T.r01(x * 7 + m * 97 + v * 31, y * 13 + m * 53, 11);
            var d = (h - 0.5) * 40;
            var band = T.r01((x / 3) | 0, (y / 3) | 0, 29 + m * 3);
            d += (band - 0.5) * 16;
            var r = c[0] + d, gg = c[1] + d, b = c[2] + d;
            if (y === 0) { r += 15; gg += 15; b += 15; }
            if (y === TS - 1) { r -= 18; gg -= 18; b -= 18; }
            var i = (y * TS + x) * 4;
            img.data[i] = clamp255(r); img.data[i + 1] = clamp255(gg);
            img.data[i + 2] = clamp255(b); img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
        variants.push(cv);
      }
      atlas[m] = variants;
    }
  }

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
      if (m.t === 'err') { toast(m.err, false); return; }
      onServer(m);
    };
  }
  function send(o) { if (ws && wsReady && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function b64ToBytes(b) {
    var bin = atob(b), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  function onServer(m) {
    switch (m.t) {
      case 'welcome':
        S.ready = true; S.map = m.map; S.maps = m.maps;
        S.x = m.x; S.y = m.y; S.cam.x = m.x; S.cam.y = m.y;
        S.energy = m.energy; S.energyMax = m.energyMax; S.reach = m.reach; S.attackRange = m.attackRange;
        S.hp = m.hp; S.maxHp = m.maxHp; S.atk = m.atk; S.kills = m.kills; S.inv = m.inv;
        S.claimed = m.claimed; S.total = m.total; S.online = m.online;
        setMapName(); buildHotbar();
        document.getElementById('h-name').textContent = m.name;
        document.getElementById('gate').style.display = 'none';
        break;

      case 'arrived':
        S.map = m.map; S.maps = m.maps; S.x = m.x; S.y = m.y;
        S.cam.x = m.x; S.cam.y = m.y;
        S.edits.clear(); S.nodes.clear(); S.mons.clear(); S.baseCache.clear();
        S.claimed = m.claimed; S.total = m.total;
        setMapName(); closeTravel();
        toast('ARRIVED — ' + m.name, true);
        break;

      case 'chunk':
        if (m.map !== S.map) break;
        var d = b64ToBytes(m.d);
        for (var i = 0; i + 3 < d.length; i += 4) {
          S.edits.set(tk(m.cx * CHUNK + d[i], m.cy * CHUNK + d[i + 1]), { m: d[i + 2], owner: m.owners[d[i + 3]] });
        }
        if (m.nodes) for (var n = 0; n < m.nodes.length; n++) applyNode(m.nodes[n]);
        if (S.edits.size > 400000) pruneEdits();
        break;

      case 'tiles': {
        var l = m.list[0];
        if (l[2] === -1) S.edits.delete(tk(l[0], l[1]));
        else S.edits.set(tk(l[0], l[1]), { m: l[2], owner: l[3] });
        break;
      }
      case 'unclaim': S.edits.delete(tk(m.x, m.y)); S.claimed = m.claimed; break;
      case 'you':
        S.energy = m.energy; S.claimed = m.claimed;
        S.edits.set(tk(m.x, m.y), { m: m.m, owner: S.key });
        break;
      case 'node': applyNode([m.x, m.y, m.kind, m.state, m.ripeSec]); break;

      case 'harvested': {
        if (m.err) { toast(m.err.toUpperCase() + (m.wait ? ' — ' + m.wait + 's' : '')); break; }
        var nd = S.nodes.get(nkN(m.x, m.y));
        if (nd && m.state === 0) { nd.state = 0; nd.until = Date.now() + (m.ripeSec || 0) * 1000; }
        if (m.inv) S.inv = m.inv;
        if (m.gains) {
          for (var y2 in m.gains) float(m.x, m.y, '+' + m.gains[y2] + ' ' + y2, '#c9e08a');
        } else if (m.partial) {
          float(m.x, m.y, 'struck', '#cbbf9a');
        }
        break;
      }

      case 'mons': {
        var seen = new Set(), L = m.list, k = 0;
        for (; k < L.length; k++) {
          var id = L[k][0]; seen.add(id);
          var e = S.mons.get(id);
          if (!e) S.mons.set(id, { kind: L[k][1], x: L[k][2], y: L[k][3], rx: L[k][2], ry: L[k][3], hp: L[k][4], maxHp: L[k][5], hit: 0 });
          else { e.x = L[k][2]; e.y = L[k][3]; e.kind = L[k][1]; e.hp = L[k][4]; e.maxHp = L[k][5]; }
        }
        S.mons.forEach(function (v, id2) { if (!seen.has(id2)) S.mons.delete(id2); });
        break;
      }
      case 'mon':
        S.mons.set(m.id, { kind: m.kind, x: m.x, y: m.y, rx: m.x, ry: m.y, hp: m.maxHp, maxHp: m.maxHp, hit: 0 });
        break;

      case 'combat': {
        if (m.err) { toast(m.err.toUpperCase()); break; }
        var mm = S.mons.get(m.id);
        if (m.killed) {
          S.kills = m.kills; S.atk = m.atk; S.inv = m.inv;
          if (mm) { float(mm.rx, mm.ry, 'SLAIN', '#ffd479'); S.mons.delete(m.id); }
          toast('SLAIN: ' + m.name + '  +1 ' + m.loot, true);
        } else {
          if (mm) { mm.hp = m.hp; mm.hit = Date.now(); float(mm.rx, mm.ry - 1, '-' + Math.max(1, Math.round((m.maxHp - m.hp) % 100 || 7)), '#ffd479'); }
        }
        break;
      }
      case 'dmg':
        S.hp = m.hp; S.maxHp = m.maxHp;
        float(S.x, S.y - 1, '-' + m.dmg, '#ff8a70');
        break;
      case 'died':
        S.hp = m.hp; S.maxHp = m.maxHp; S.x = m.spawn.x; S.y = m.spawn.y;
        S.cam.x = S.x; S.cam.y = S.y;
        S.edits.clear(); S.nodes.clear(); S.mons.clear(); S.baseCache.clear(); S.lastViewCk = '';
        toast('YOU WERE SLAIN BY ' + String(m.by).toUpperCase() + ' — RETURNED TO THE SHORE');
        break;
      case 'vitals':
        S.hp = m.hp; S.maxHp = m.maxHp; S.inv = m.inv; S.kills = m.kills; S.atk = m.atk;
        break;
      case 'stats':
        S.claimed = m.claimed; S.total = m.total; S.online = m.online; S.volatile = m.volatile;
        break;
      case 'players': {
        var seen2 = new Set();
        for (var j = 0; j < m.list.length; j++) {
          var p = m.list[j]; seen2.add(p[0]);
          var r = S.remotes.get(p[0]);
          if (!r) S.remotes.set(p[0], { name: p[1], x: p[2], y: p[3], rx: p[2], ry: p[3], hue: p[4] });
          else { r.x = p[2]; r.y = p[3]; r.name = p[1]; }
        }
        S.remotes.forEach(function (v, kk) { if (!seen2.has(kk)) S.remotes.delete(kk); });
        if (m.you && Math.abs(S.energy - m.you[2]) > 4) S.energy = m.you[2];
        break;
      }
      case 'map': if (m.map === S.map) { S.mapDensity = b64ToBytes(m.d); drawMap(); } break;
      case 'pong': break;
    }
  }

  function applyNode(a) {
    S.nodes.set(nkN(a[0], a[1]), { kind: a[2], state: a[3], until: a[3] === 0 ? 0 : Date.now() + (a[4] || 0) * 1000 });
  }
  function pruneEdits() {
    var keep = new Map();
    S.edits.forEach(function (v, k) {
      var x = k % W, y = (k / W) | 0;
      if (Math.abs(x - S.x) < 400 && Math.abs(y - S.y) < 400) keep.set(k, v);
    });
    S.edits = keep;
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
    if (m === RELEASE) S.edits.delete(tk(x, y));
    else { S.edits.set(tk(x, y), { m: m, owner: S.key }); S.energy -= 1; }
    send({ t: 'set', x: x, y: y, m: m });
  }

  /** One button, context-sensitive: strike a beast, else harvest, else build. */
  function contextAction(x, y) {
    var mon = monAt(x, y);
    if (mon) {
      var d = Math.hypot(mon.x - S.x, mon.y - S.y);
      if (d > S.attackRange + 1) return toast('TOO FAR TO STRIKE');
      send({ t: 'attack', id: mon.id });
      return;
    }
    var nd = S.nodes.get(nkN(x, y));
    if (nd && nd.state === 1) {
      var dx = x - S.x, dy = y - S.y;
      if (dx * dx + dy * dy > S.reach * S.reach) return toast('OUT OF REACH');
      send({ t: 'harvest', x: x, y: y });
      return;
    }
    if (nd && nd.state === 0) {
      var left = Math.max(0, Math.ceil((nd.until - Date.now()) / 1000));
      return toast('REGROWING — ' + left + 's');
    }
    tryPlace(x, y, PALETTE[S.sel]);
  }

  function monAt(x, y) {
    var best = null, bd = 1.3;
    S.mons.forEach(function (m, id) {
      var d = Math.hypot(m.rx - (x + 0.5), m.ry - (y + 0.5));
      if (d < bd) { bd = d; best = m; best.id = id; }
    });
    return best;
  }

  // ---------- input --------------------------------------------------------
  var keys = {};
  window.addEventListener('keydown', function (e) {
    var k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'm') { toggleMap(); e.preventDefault(); return; }
    if (k === 't') { toggleTravel(); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (S.mapOpen) toggleMap(); if (S.travelOpen) closeTravel(); return; }
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
    if (S.mapOpen || S.travelOpen) return;
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
    if (S.mapOpen || S.travelOpen) return;                 // overlays handle their own taps
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

  // ---------- HUD ----------------------------------------------------------
  var hotbar = document.getElementById('hotbar');
  function buildHotbar() {
    var html = '';
    for (var i = 0; i < PALETTE.length; i++) {
      var m = PALETTE[i], c = CLR[m];
      html += '<div class="slot' + (i === S.sel ? ' on' : '') + '" data-i="' + i + '" title="' + MATNAME[m] +
        '" style="background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')">' +
        '<span class="n">' + (i === 9 ? '0' : String(i + 1)) + '</span></div>';
    }
    hotbar.innerHTML = html;
    document.getElementById('h-sel').textContent = 'building: ' + MATNAME[PALETTE[S.sel]];
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
  function float(x, y, text, color) {
    S.floats.push({ x: x + 0.5, y: y + 0.2, text: text, color: color, t: 0 });
    if (S.floats.length > 40) S.floats.shift();
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

    if (S.ready) {
      if (!S.mapOpen && !S.travelOpen) {
        var sp = 9.5 * dt, vx = 0, vy = 0;
        if (keys['a'] || keys['arrowleft']) vx -= 1;
        if (keys['d'] || keys['arrowright']) vx += 1;
        if (keys['w'] || keys['arrowup']) vy -= 1;
        if (keys['s'] || keys['arrowdown']) vy += 1;
        if (S.joy) { vx += S.joy.x; vy += S.joy.y; }
        var L = Math.hypot(vx, vy);
        if (L > 1) { vx /= L; vy /= L; L = 1; }          // analog: a half-pushed stick walks at half speed
        if (L > 0.01) {
          var nx = Math.max(1, Math.min(W - 2, S.x + vx * sp));
          var ny = Math.max(1, Math.min(H - 2, S.y + vy * sp));
          if (tileAt(Math.round(nx), Math.round(ny)) !== 0) { S.x = nx; S.y = ny; }
        }
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

    render(now);
    hud();
    requestAnimationFrame(frame);
  }

  function render(now) {
    var s = TS * S.zoom, cw = VW, ch = VH;
    var x0 = Math.floor(S.cam.x - cw / 2 / s) - 1, x1 = Math.ceil(S.cam.x + cw / 2 / s) + 1;
    var y0 = Math.floor(S.cam.y - ch / 2 / s) - 1, y1 = Math.ceil(S.cam.y + ch / 2 / s) + 1;
    function px(x) { return Math.round((x - S.cam.x) * s + cw / 2); }
    function py(y) { return Math.round((y - S.cam.y) * s + ch / 2); }

    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;
    var wt = (now / 260) | 0;

    for (var y = y0; y <= y1; y++) {
      if (y < 0 || y >= H) continue;
      var yy = py(y);
      for (var x = x0; x <= x1; x++) {
        if (x < 0 || x >= W) continue;
        var xx = px(x), m = tileAt(x, y);
        ctx.drawImage(atlas[m] ? atlas[m][T.hash2(x, y, 3) & 3] : atlas[0][0], xx, yy, s, s);
        if (m === 5) {
          var off = ((x * 7 + wt) % 4) - 2;
          ctx.globalAlpha = 0.10; ctx.fillStyle = '#cfe8ff';
          ctx.fillRect(xx, yy + Math.round(s * 0.25) + off, s, Math.max(1, s * 0.09));
          ctx.globalAlpha = 1;
        }
      }
    }

    // resource nodes (volatile layer)
    S.nodes.forEach(function (nd, k) {
      var c = k.split(','), x = +c[0], y = +c[1];
      if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) return;
      drawNode(px(x), py(y), s, nd);
    });

    // lamps
    S.edits.forEach(function (e, k) {
      if (e.m !== 10) return;
      var x = k % W, y = (k / W) | 0;
      if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) return;
      var cx = px(x) + s / 2, cy = py(y) + s / 2;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 4.5);
      g.addColorStop(0, 'rgba(255,214,140,0.34)');
      g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - s * 4.5, cy - s * 4.5, s * 9, s * 9);
    });

    // monsters
    S.mons.forEach(function (m) {
      m.rx += (m.x - m.rx) * 0.2; m.ry += (m.y - m.ry) * 0.2;
      var mx = (m.rx - S.cam.x) * s + cw / 2, my = (m.ry - S.cam.y) * s + ch / 2;
      var pal = MONCLR[S.map] || MONCLR[0];
      var col = pal[m.kind % pal.length];
      var w = Math.max(7, s * 0.72), h = Math.max(7, s * 0.6);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(mx, my + h * 0.42, w * 0.5, h * 0.2, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(mx, my, w * 0.5, h * 0.48, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.fillRect(mx - w * 0.22, my - h * 0.14, Math.max(1, s * 0.09), Math.max(1, s * 0.09));
      ctx.fillRect(mx + w * 0.10, my - h * 0.14, Math.max(1, s * 0.09), Math.max(1, s * 0.09));
      if (now - m.hit < 160) { ctx.fillStyle = 'rgba(255,120,90,.55)'; ctx.beginPath(); ctx.ellipse(mx, my, w * 0.6, h * 0.58, 0, 0, 6.29); ctx.fill(); }
      if (m.hp < m.maxHp) {
        var bw = w * 1.05;
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(mx - bw / 2, my - h * 0.95, bw, 3);
        ctx.fillStyle = '#c0563f'; ctx.fillRect(mx - bw / 2, my - h * 0.95, bw * Math.max(0, m.hp / m.maxHp), 3);
      }
    });

    // remote players
    S.remotes.forEach(function (p) {
      p.rx += (p.x - p.rx) * 0.18; p.ry += (p.y - p.ry) * 0.18;
      var ppx = (p.rx - S.cam.x) * s + cw / 2, ppy = (p.ry - S.cam.y) * s + ch / 2;
      drawFigure(ppx, ppy, s, p.hue, false);
      ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(p.name, ppx + 1, ppy - s * 1.15 + 1);
      ctx.fillStyle = '#e8e6df'; ctx.fillText(p.name, ppx, ppy - s * 1.15);
    });

    drawFigure(cw / 2, ch / 2, s, 0, true);

    // floating combat text
    ctx.textAlign = 'center';
    ctx.font = '11px ui-monospace,monospace';
    for (var i = S.floats.length - 1; i >= 0; i--) {
      var f = S.floats[i];
      f.t += 0.016;
      if (f.t > 1.2) { S.floats.splice(i, 1); continue; }
      var fxp = (f.x - S.cam.x) * s + cw / 2, fyp = (f.y - S.cam.y) * s + ch / 2 - f.t * 26;
      ctx.globalAlpha = Math.max(0, 1 - f.t / 1.2);
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(f.text, fxp + 1, fyp + 1);
      ctx.fillStyle = f.color; ctx.fillText(f.text, fxp, fyp);
      ctx.globalAlpha = 1;
    }

    // hover cursor
    if (S.ready && !S.mapOpen && !S.travelOpen) {
      var t = screenToTile(S.mouse.x, S.mouse.y);
      if (t.x >= 0 && t.y >= 0 && t.x < W && t.y < H) {
        var hx = px(t.x), hy = py(t.y);
        var dxx = t.x - S.x, dyy = t.y - S.y, inReach = (dxx * dxx + dyy * dyy) <= S.reach * S.reach;
        var cur = S.edits.get(tk(t.x, t.y)), mine = !cur || cur.owner === S.key;
        var mon = monAt(t.x, t.y);
        var nd = S.nodes.get(nkN(t.x, t.y));
        var col2 = mon ? (Math.hypot(mon.x - S.x, mon.y - S.y) <= S.attackRange + 1 ? 'rgba(255,120,90,.95)' : 'rgba(230,180,70,.9)')
          : (inReach && (mine || (nd && nd.state === 1))) ? 'rgba(255,255,255,.85)' : 'rgba(230,90,70,.9)';
        ctx.lineWidth = 1; ctx.strokeStyle = col2;
        ctx.strokeRect(hx + .5, hy + .5, s - 1, s - 1);
      }
    }
  }

  function drawNode(x, y, s, nd) {
    var alive = nd.state === 1, a = alive ? 1 : 0.24;
    ctx.globalAlpha = a;
    var cx = x + s / 2, cy = y + s / 2;
    if (nd.kind === 1) {              // tree
      ctx.fillStyle = '#5a3d22';
      ctx.fillRect(cx - Math.max(1, s * 0.07), cy - s * 0.06, Math.max(2, s * 0.14), s * 0.5);
      ctx.fillStyle = NODECLR[1];
      ctx.beginPath(); ctx.ellipse(cx, cy - s * 0.18, s * 0.34, s * 0.29, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.ellipse(cx - s * 0.1, cy - s * 0.27, s * 0.13, s * 0.1, 0, 0, 6.29); ctx.fill();
    } else if (nd.kind === 2) {       // ore seam
      ctx.fillStyle = '#7d766a';
      ctx.beginPath(); ctx.ellipse(cx, cy + s * 0.06, s * 0.3, s * 0.22, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#b08a3e';
      ctx.fillRect(cx - s * 0.16, cy - s * 0.08, Math.max(1, s * 0.11), Math.max(1, s * 0.11));
      ctx.fillRect(cx + s * 0.05, cy + s * 0.02, Math.max(1, s * 0.09), Math.max(1, s * 0.09));
    } else if (nd.kind === 3) {       // herb
      ctx.strokeStyle = NODECLR[3]; ctx.lineWidth = Math.max(1, s * 0.07);
      for (var i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(cx + i * s * 0.13, cy + s * 0.3);
        ctx.lineTo(cx + i * s * 0.22, cy - s * 0.08 - Math.abs(i) * s * 0.05);
        ctx.stroke();
      }
    } else {                          // crystal
      ctx.fillStyle = NODECLR[4];
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.38); ctx.lineTo(cx + s * 0.19, cy + s * 0.16);
      ctx.lineTo(cx - s * 0.19, cy + s * 0.16); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.22, cy - s * 0.1); ctx.lineTo(cx + s * 0.34, cy + s * 0.2);
      ctx.lineTo(cx + s * 0.1, cy + s * 0.2); ctx.closePath(); ctx.fill();
      if (alive) {
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 2.2);
        g.addColorStop(0, 'rgba(150,230,255,0.26)');
        g.addColorStop(1, 'rgba(150,230,255,0)');
        ctx.fillStyle = g; ctx.fillRect(cx - s * 2.2, cy - s * 2.2, s * 4.4, s * 4.4);
      }
    }
    ctx.globalAlpha = 1;
    if (!alive) {   // regrowth countdown on the tile itself
      var left = Math.max(0, Math.ceil((nd.until - Date.now()) / 1000));
      if (left > 0 && s >= 13) {
        ctx.font = Math.max(7, s * 0.42) + 'px ui-monospace,monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(left + 's', cx + 1, cy + s * 0.42 + 1);
        ctx.fillStyle = '#cbbf9a'; ctx.fillText(left + 's', cx, cy + s * 0.42);
      }
    }
  }

  function drawFigure(ppx, ppy, s, hue, isSelf) {
    var bob = isSelf ? Math.sin(performance.now() / 220) * (s * 0.035) : 0;
    var w = Math.max(5, s * 0.5), h = Math.max(8, s * 0.78);
    var bx = ppx - w / 2, by = ppy - h + s * 0.28 + bob;
    ctx.fillStyle = 'rgba(0,0,0,.32)';
    ctx.beginPath(); ctx.ellipse(ppx, ppy + s * 0.32, w * 0.62, h * 0.17, 0, 0, 6.29); ctx.fill();
    var body = isSelf ? '#e8e6df' : 'hsl(' + hue + ',58%,62%)';
    var trim = isSelf ? '#c9a55c' : 'hsl(' + hue + ',48%,40%)';
    ctx.fillStyle = trim; ctx.fillRect(bx, by + h * 0.42, w, h * 0.58);
    ctx.fillStyle = body; ctx.fillRect(bx, by + h * 0.38, w, h * 0.26);
    ctx.fillRect(bx + w * 0.12, by - h * 0.02, w * 0.76, h * 0.42);
    ctx.fillStyle = isSelf ? '#2a2419' : 'rgba(20,20,26,.85)';
    ctx.fillRect(bx + w * 0.28, by + h * 0.16, w * 0.14, h * 0.07);
    ctx.fillRect(bx + w * 0.58, by + h * 0.16, w * 0.14, h * 0.07);
    if (isSelf) {
      ctx.strokeStyle = 'rgba(201,165,92,.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(ppx, ppy + s * 0.32, w * 0.85, 0, 6.29); ctx.stroke();
    }
  }

  function hud() {
    document.getElementById('h-online').textContent = S.online;
    document.getElementById('h-pos').textContent = Math.round(S.x) + ', ' + Math.round(S.y);
    document.getElementById('h-hp').textContent = Math.round(S.hp) + ' / ' + S.maxHp;
    document.querySelector('#hpbar>div').style.width = Math.max(0, (S.hp / S.maxHp) * 100).toFixed(1) + '%';
    document.getElementById('h-energy').textContent = Math.floor(S.energy);
    document.querySelector('#willbar>div').style.width = ((S.energy / S.energyMax) * 100).toFixed(1) + '%';
    document.getElementById('h-pct').textContent = ((S.claimed / S.total) * 100).toFixed(4) + '%';
    document.getElementById('h-claimed').textContent = S.claimed.toLocaleString() + ' / ' + S.total.toLocaleString();
    document.getElementById('h-remain').textContent = (S.total - S.claimed).toLocaleString();
    document.getElementById('h-kills').textContent = S.kills;
    document.getElementById('h-atk').textContent = S.atk;
    var inv = S.inv || {}, ih = '';
    ['wood', 'ore', 'herb', 'crystal'].forEach(function (r) {
      ih += '<span class="chip">' + r + ' ' + (inv[r] || 0) + '</span>';
    });
    document.getElementById('h-inv').innerHTML = ih;
    if (S.volatile) {
      document.getElementById('h-vol').textContent =
        'beasts ' + S.volatile.monstersLive + ' · regrowing ' + S.volatile.nodesDepleted;
    }
  }

  // ---------- boot ---------------------------------------------------------
  function boot() {
    resize(); buildAtlas(); buildMapBase(0);
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
      connect();
    }
    requestAnimationFrame(frame);
  }
  boot();
})();
