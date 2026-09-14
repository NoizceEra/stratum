/*!
 * STRATUM - public/audio.js
 * Procedural sound engine (Web Audio API). No asset files, no network, no build step.
 *
 * ---------------------------------------------------------------------------
 * GESTURE UNLOCK (read this before wiring it up)
 * ---------------------------------------------------------------------------
 * Mobile browsers (and Chrome/Safari desktop after a page refresh policy change)
 * refuse to start an AudioContext until the user has interacted with the page.
 * An AudioContext created outside a gesture starts in the "suspended" state and
 * stays silent. So:
 *
 *   1. Optionally call SFX.init() whenever you like - it only *creates* the
 *      AudioContext lazily and never throws, even with no user gesture.
 *   2. Call SFX.unlock() from your FIRST real user gesture (touchstart / click /
 *      keydown handler, or the first pointer event in the game canvas). unlock()
 *      creates the context if needed and resumes it, handling the returned
 *      promise. It is cheap and idempotent, so calling it on every gesture is
 *      fine.
 *   3. After that, SFX.play(name, opts) works from anywhere: game loop, timers,
 *      AI turns, etc.
 *
 * Example integration:
 *
 *   window.addEventListener('touchstart', SFX.unlock, { once: true });
 *   window.addEventListener('click',      SFX.unlock, { once: true });
 *   // or, per gesture, on the canvas:  canvas.addEventListener('pointerdown', SFX.unlock);
 *
 *   SFX.play('attack');                 // swing
 *   SFX.play('hit',   { pan: -0.4 });   // impact to the left
 *   SFX.play('crit',  { pitch: 1.1 });  // bigger crit
 *   SFX.play('levelup');
 *   SFX.play('ui',    { volume: 0.5 });
 *   SFX.setVolume(0.4);  SFX.disable();  SFX.enable();
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES
 * ---------------------------------------------------------------------------
 * - Everything is synthesised at runtime: oscillators, a shared white-noise
 *   buffer, biquad filters and gain envelopes. Nothing is fetched, decoded or
 *   embedded.
 * - Every public method is a safe no-op when the AudioContext is missing or
 *   has not been created yet. play() NEVER throws - unknown names, garbage
 *   opts, dead contexts and closed contexts are all swallowed.
 * - Voice management: at most 24 simultaneous voices; the oldest is faded out
 *   and stop()ped when a new one would exceed the cap, so a burst of hits
 *   cannot explode the graph or clip.
 * - Output chain: per-sound parts -> per-voice panner/gain -> SFX master gain
 *   -> DynamicsCompressor configured as a near brickwall limiter -> tanh
 *   soft-clip ceiling -> destination. The limiter keeps normal play at a sane
 *   level; the soft clipper means a pathological burst still cannot clip.
 * - Each call gets a small random pitch (+/-2%) and volume (+/-8%) wobble so
 *   repeated sounds do not sound robotic.
 * - Plain ES5 script. Load with <script src="audio.js"></script>; it defines
 *   window.SFX. No modules, no require, no DOM access beyond window/AudioContext.
 */
(function (global) {
  'use strict';

  var MAX_VOICES = 24;          // hard cap on simultaneous voices
  var DEFAULT_VOLUME = 0.42;    // modest master level (leaves burst headroom)
  var NOISE_SECONDS = 1.0;      // length of the shared white-noise buffer

  var ctx = null;               // AudioContext (created lazily by init/unlock)
  var master = null;            // master GainNode
  var limiter = null;           // DynamicsCompressor used as a limiter
  var noiseBuf = null;          // shared white-noise AudioBuffer
  var voices = [];              // active voice records, oldest first
  var enabled = true;
  var volume = DEFAULT_VOLUME;
  var Ctor = null;              // cached AudioContext constructor
  var CtorLooked = false;

  /* ------------------------------------------------------------------ *
   * small utilities
   * ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function audioCtor() {
    if (CtorLooked) return Ctor;
    CtorLooked = true;
    try {
      if (global) Ctor = global.AudioContext || global.webkitAudioContext || null;
    } catch (e) {
      Ctor = null;
    }
    return Ctor;
  }

  function getNoise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.max(128, Math.floor(ctx.sampleRate * NOISE_SECONDS));
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  /* ------------------------------------------------------------------ *
   * context / lifecycle
   * ------------------------------------------------------------------ */

  // Soft-clip curve for the final WaveShaper. The WaveShaper input domain is
  // -1..+1 (anything beyond clamps to the curve ends), so a tanh curve with
  // unity slope at zero fixes an absolute output ceiling of tanh(1) = 0.762,
  // while staying transparent (-0.7 dB or better) for the ~0.5 peaks that
  // normal play actually produces.
  function softClipCurve(size) {
    var n = Math.max(64, size || 1024);
    var curve = new Float32Array(n);
    var hasTanh = typeof Math.tanh === 'function';
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;   // curve spans input -1..+1
      var y;
      if (hasTanh) {
        y = Math.tanh(x);              // slope 1 at 0, ceil 0.7616
      } else {
        // Pade approximation of tanh for engines without Math.tanh
        var u2 = x * x;
        y = (x * (27 + u2)) / (27 + 9 * u2);
      }
      curve[i] = y < -1 ? -1 : (y > 1 ? 1 : y);
    }
    return curve;
  }

  function init() {
    if (ctx) return ctx;
    var C = audioCtor();
    if (!C) return null;
    try {
      ctx = new C();
    } catch (e) {
      ctx = null;
      return null;
    }
    try {
      master = ctx.createGain();
      master.gain.value = enabled ? volume : 0;

      limiter = ctx.createDynamicsCompressor();
      if (limiter.threshold) limiter.threshold.value = -8;   // start squashing at -8 dBFS
      if (limiter.knee) limiter.knee.value = 0;              // hard knee
      if (limiter.ratio) limiter.ratio.value = 20;           // near brickwall
      if (limiter.attack) limiter.attack.value = 0.001;    // fast: minimal transient overshoot
      if (limiter.release) limiter.release.value = 0.15;

      master.connect(limiter);
      // A compressor still overshoots for a few ms on a big transient, so the
      // last stage is a tanh soft-clip curve: an absolute ceiling below 0 dBFS
      // whatever a burst of voices does. Optional - skipped if unsupported.
      var tail = limiter;
      if (typeof ctx.createWaveShaper === 'function') {
        try {
          var clip = ctx.createWaveShaper();
          clip.curve = softClipCurve(2048);
          if ('oversample' in clip) clip.oversample = '2x';
          limiter.connect(clip);
          tail = clip;
        } catch (e2) {
          tail = limiter;
        }
      }
      tail.connect(ctx.destination);
    } catch (e) {
      // Partially built graph is still usable; degrade to direct-to-destination.
      try {
        if (master) master.connect(ctx.destination);
      } catch (e3) { /* nothing else to do */ }
    }
    return ctx;
  }

  function unlock() {
    try {
      if (!ctx) init();
      if (!ctx) return false;
      if (typeof ctx.resume === 'function' &&
          (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
        var p = ctx.resume();
        if (p && typeof p.then === 'function') {
          // Restore master level once the context is actually running.
          p.then(function () {
            rampMaster(enabled ? volume : 0, 0.05);
          })['catch'](function () { /* user never gestured; stay silent */ });
        }
      }
      // Resume the shared noise buffer path too (no-op, kept for symmetry).
      return true;
    } catch (e) {
      return false;
    }
  }

  function rampMaster(target, seconds) {
    if (!ctx || !master) return;
    try {
      var t = ctx.currentTime;
      var g = master.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(target, t + (seconds || 0.05));
    } catch (e) {
      try { master.gain.value = target; } catch (e2) { /* ignore */ }
    }
  }

  function enable() {
    enabled = true;
    if (ctx && master) rampMaster(volume, 0.06);
  }

  function disable() {
    enabled = false;
    if (ctx && master) rampMaster(0, 0.06);
  }

  function setVolume(v) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    volume = clamp(v, 0, 1);
    if (master) rampMaster(enabled ? volume : 0, 0.04);
  }

  /* ------------------------------------------------------------------ *
   * voice management
   * ------------------------------------------------------------------ */

  // Fade a voice out and stop its sources. The record stays in the list until
  // reaped so the fade is not cut short; retire() then disconnects its bus.
  function killVoice(v) {
    if (!v || v.dead) return;
    var t = now();
    try {
      var g = v.g.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.0001, t + 0.012);   // click-free fade
    } catch (e) { /* ignore */ }
    for (var i = 0; i < v.src.length; i++) {
      try { v.src[i].stop(t + 0.02); } catch (e2) { /* already stopped */ }
    }
    v.dead = true;
    v.end = t + 0.02;
  }

  // Drop a finished voice from the graph so its bus gain/panner can be collected.
  function retire(v) {
    try { v.g.disconnect(); } catch (e) { /* ignore */ }
    if (v.p) { try { v.p.disconnect(); } catch (e2) { /* ignore */ } }
    v.dead = true;
  }

  function newVoice(pan) {
    var t = now();
    var i, active, idx;

    // Reap voices that have finished, and retire the dead ones for good.
    for (i = voices.length - 1; i >= 0; i--) {
      if (voices[i].end <= t) {
        retire(voices[i]);
        voices.splice(i, 1);
      }
    }
    // Hard safety: never let the bookkeeping list grow without bound.
    while (voices.length > MAX_VOICES * 4) {
      idx = -1;
      for (i = 0; i < voices.length; i++) { if (voices[i].dead) { idx = i; break; } }
      if (idx < 0) break;
      retire(voices[idx]);
      voices.splice(idx, 1);
    }

    // Enforce the cap on *live* voices: drop the oldest still-sounding one.
    active = 0;
    for (i = 0; i < voices.length; i++) { if (!voices[i].dead) active++; }
    while (active >= MAX_VOICES) {
      idx = -1;
      for (i = 0; i < voices.length; i++) { if (!voices[i].dead) { idx = i; break; } }
      if (idx < 0) break;
      killVoice(voices[idx]);
      active--;
    }

    var g = ctx.createGain();
    g.gain.value = 1;
    var p = null;
    if (typeof ctx.createStereoPanner === 'function') {
      try {
        p = ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        g.connect(p);
        p.connect(master);
      } catch (e) {
        p = null;
        try { g.connect(master); } catch (e2) { /* ignore */ }
      }
    } else {
      try { g.connect(master); } catch (e) { /* ignore */ }
    }

    var v = { g: g, p: p, src: [], end: t + 0.5 };
    voices.push(v);
    return v;
  }

  /* ------------------------------------------------------------------ *
   * synthesis primitives
   * ------------------------------------------------------------------ */

  // Percussive attack/decay envelope with exponential tail. Returns the end time.
  function env(param, t0, peak, attack, decay) {
    var a = Math.max(0.0004, attack || 0.003);
    var d = Math.max(0.008, decay || 0.1);
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
      param.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    } catch (e) { /* ignore */ }
    return t0 + a + d;
  }

  // Hold envelope: attack -> hold -> quick release (used by buzz / rumble).
  function envHold(param, t0, peak, attack, hold, release) {
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
      param.setValueAtTime(Math.max(0.0002, peak), t0 + attack + hold);
      param.linearRampToValueAtTime(0.0001, t0 + attack + hold + release);
    } catch (e) { /* ignore */ }
    return t0 + attack + hold + release;
  }

  // Gain rises from silence up to peak then snaps off: the "reverse" envelope.
  function envReverse(param, t0, peak, rise, tail) {
    try {
      param.cancelScheduledValues(t0);
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + rise);
      param.linearRampToValueAtTime(0.0001, t0 + rise + tail);
    } catch (e) { /* ignore */ }
    return t0 + rise + tail;
  }

  function sweep(param, t0, from, to, seconds, linear) {
    try {
      param.setValueAtTime(Math.max(1, from), t0);
      if (linear) {
        param.linearRampToValueAtTime(Math.max(1, to), t0 + seconds);
      } else {
        param.exponentialRampToValueAtTime(Math.max(1, to), t0 + seconds);
      }
    } catch (e) { /* ignore */ }
  }

  function oscPart(v, type, freq, detune) {
    var o = ctx.createOscillator();
    try { o.type = type; } catch (e) { /* keep default waveform */ }
    try { o.frequency.value = Math.max(1, freq); } catch (e2) { /* ignore */ }
    if (detune) { try { o.detune.value = detune; } catch (e3) { /* ignore */ } }
    var g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g);
    g.connect(v.g);
    v.src.push(o);
    return { o: o, g: g };
  }

  function noisePart(v) {
    var s = ctx.createBufferSource();
    s.buffer = getNoise();
    s.loop = true;
    var g = ctx.createGain();
    g.gain.value = 0;
    s.connect(g);
    g.connect(v.g);
    v.src.push(s);
    return { o: s, g: g };
  }

  function filterPart(v, srcGain, type, freq, q) {
    var f = ctx.createBiquadFilter();
    try { f.type = type; } catch (e) { /* ignore */ }
    try {
      f.frequency.value = Math.max(20, Math.min(20000, freq));
      if (q) f.Q.value = q;
    } catch (e2) { /* ignore */ }
    try {
      srcGain.disconnect();
      srcGain.connect(f);
      f.connect(v.g);
    } catch (e3) {
      try { srcGain.connect(v.g); } catch (e4) { /* ignore */ }
    }
    return f;
  }

  function start(part, t0, stopAt, offset) {
    try { part.o.start(t0, offset || 0); } catch (e) { /* ignore */ }
    try { part.o.stop(stopAt); } catch (e2) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ *
   * the sound library - each builder returns its duration in seconds
   * ------------------------------------------------------------------ */

  // 'place' - dull thud: dirt settling into a tile.
  function sPlace(v, t0, pitch, vol) {
    var dur = 0.17;
    var body = oscPart(v, 'sine', 152 * pitch);
    sweep(body.o.frequency, t0, 152 * pitch, 60 * pitch, 0.13);
    env(body.g.gain, t0, 0.85 * vol, 0.004, 0.13);
    start(body, t0, t0 + dur);

    var n = noisePart(v);
    filterPart(v, n.g, 'lowpass', 420 * pitch, 0.9);
    env(n.g.gain, t0, 0.30 * vol, 0.002, 0.075);
    start(n, t0, t0 + dur);
    return dur;
  }

  // 'release' - soft reverse blip: a pickup / cancel, rising into nothing.
  function sRelease(v, t0, pitch, vol) {
    var dur = 0.24;
    var o = oscPart(v, 'sine', 200 * pitch);
    sweep(o.o.frequency, t0, 200 * pitch, 760 * pitch, 0.18);
    envReverse(o.g.gain, t0, 0.42 * vol, 0.17, 0.04);
    start(o, t0, t0 + dur);

    var n = noisePart(v);
    filterPart(v, n.g, 'bandpass', 900 * pitch, 2.5);
    envReverse(n.g.gain, t0, 0.10 * vol, 0.15, 0.05);
    start(n, t0, t0 + dur);
    return dur;
  }

  // 'harvest' - crisp chime: bright bell partials plus a woody snap.
  function sHarvest(v, t0, pitch, vol) {
    var dur = 0.5;
    var f = 880 * pitch;
    var ratios = [1, 2.01, 3.02];
    var peaks = [0.42, 0.20, 0.09];
    var decs = [0.34, 0.24, 0.16];
    for (var i = 0; i < ratios.length; i++) {
      var o = oscPart(v, 'sine', f * ratios[i]);
      env(o.g.gain, t0, peaks[i] * vol, 0.002, decs[i]);
      start(o, t0, t0 + Math.min(dur, 0.01 + decs[i] + 0.03));
    }
    var n = noisePart(v);
    filterPart(v, n.g, 'highpass', 2400 * pitch, 0.8);
    env(n.g.gain, t0, 0.16 * vol, 0.001, 0.035);
    start(n, t0, t0 + 0.08);
    return dur;
  }

  // 'attack' - short whoosh: filtered noise sweeping up.
  function sAttack(v, t0, pitch, vol) {
    var dur = 0.2;
    var n = noisePart(v);
    var f = filterPart(v, n.g, 'bandpass', 320 * pitch, 1.3);
    sweep(f.frequency, t0, 320 * pitch, 2600 * pitch, 0.14);
    env(n.g.gain, t0, 0.34 * vol, 0.035, 0.12);
    start(n, t0, t0 + dur);

    var o = oscPart(v, 'triangle', 200 * pitch);
    sweep(o.o.frequency, t0, 180 * pitch, 520 * pitch, 0.12);
    env(o.g.gain, t0, 0.10 * vol, 0.03, 0.1);
    start(o, t0, t0 + dur);
    return dur;
  }

  // 'hit' - meaty impact: low thud + lowpassed noise slap.
  function sHit(v, t0, pitch, vol) {
    var dur = 0.22;
    var body = oscPart(v, 'sine', 116 * pitch);
    sweep(body.o.frequency, t0, 116 * pitch, 52 * pitch, 0.14);
    env(body.g.gain, t0, 0.95 * vol, 0.003, 0.17);
    start(body, t0, t0 + dur);

    var skin = oscPart(v, 'triangle', 220 * pitch);
    env(skin.g.gain, t0, 0.22 * vol, 0.002, 0.06);
    start(skin, t0, t0 + dur);

    var n = noisePart(v);
    filterPart(v, n.g, 'lowpass', 950 * pitch, 1.1);
    env(n.g.gain, t0, 0.45 * vol, 0.001, 0.1);
    start(n, t0, t0 + dur);
    return dur;
  }

  // 'crit' - brighter impact with a ringing tail.
  function sCrit(v, t0, pitch, vol) {
    var dur = 0.75;
    var body = oscPart(v, 'sine', 190 * pitch);
    sweep(body.o.frequency, t0, 190 * pitch, 95 * pitch, 0.12);
    env(body.g.gain, t0, 1.0 * vol, 0.002, 0.22);
    start(body, t0, t0 + 0.35);

    var snap = noisePart(v);
    filterPart(v, snap.g, 'highpass', 1800 * pitch, 0.9);
    env(snap.g.gain, t0, 0.5 * vol, 0.001, 0.06);
    start(snap, t0, t0 + 0.12);

    var f = 1500 * pitch;
    var ratios = [1, 1.51, 2.02];
    var peaks = [0.26, 0.16, 0.10];
    var decs = [0.55, 0.45, 0.35];
    for (var i = 0; i < ratios.length; i++) {
      var o = oscPart(v, 'sine', f * ratios[i]);
      env(o.g.gain, t0, peaks[i] * vol, 0.003, decs[i]);
      start(o, t0, t0 + dur);
    }
    return dur;
  }

  // 'hurt' - low painful thud: detuned low pair with a grunt of noise.
  function sHurt(v, t0, pitch, vol) {
    var dur = 0.36;
    var a = oscPart(v, 'sine', 92 * pitch);
    var b = oscPart(v, 'sine', 97 * pitch);
    sweep(a.o.frequency, t0, 92 * pitch, 48 * pitch, 0.26);
    sweep(b.o.frequency, t0, 97 * pitch, 51 * pitch, 0.26);
    env(a.g.gain, t0, 0.7 * vol, 0.006, 0.28);
    env(b.g.gain, t0, 0.45 * vol, 0.008, 0.24);
    start(a, t0, t0 + dur);
    start(b, t0, t0 + dur);

    var n = noisePart(v);
    filterPart(v, n.g, 'lowpass', 620 * pitch, 1.0);
    env(n.g.gain, t0, 0.26 * vol, 0.004, 0.2);
    start(n, t0, t0 + dur);
    return dur;
  }

  // 'die' - descending tone: saw falls away under a closing lowpass.
  function sDie(v, t0, pitch, vol) {
    var dur = 0.9;
    var o = oscPart(v, 'sawtooth', 440 * pitch);
    sweep(o.o.frequency, t0, 440 * pitch, 62 * pitch, 0.72);
    var f = filterPart(v, o.g, 'lowpass', 1600 * pitch, 3.0);
    sweep(f.frequency, t0, 1600 * pitch, 260 * pitch, 0.72);
    env(o.g.gain, t0, 0.34 * vol, 0.01, 0.8);
    start(o, t0, t0 + dur);

    var sub = oscPart(v, 'sine', 220 * pitch);
    sweep(sub.o.frequency, t0, 220 * pitch, 40 * pitch, 0.72);
    env(sub.g.gain, t0, 0.2 * vol, 0.012, 0.78);
    start(sub, t0, t0 + dur);
    return dur;
  }

  // 'levelup' - rising arpeggio with a ringing top note.
  function sLevelup(v, t0, pitch, vol) {
    var notes = [523.25, 659.25, 783.99, 1046.50];
    var step = 0.085;
    var dur = notes.length * step + 0.6;
    for (var i = 0; i < notes.length; i++) {
      var nt = t0 + i * step;
      var o = oscPart(v, 'triangle', notes[i] * pitch);
      env(o.g.gain, nt, 0.30 * vol, 0.004, 0.26);
      start(o, nt, nt + 0.34);

      var o2 = oscPart(v, 'sine', notes[i] * pitch * 2);
      env(o2.g.gain, nt, 0.12 * vol, 0.004, 0.18);
      start(o2, nt, nt + 0.24);
    }
    // Final chord ring.
    var ring = t0 + (notes.length - 1) * step;
    var tail = oscPart(v, 'sine', notes[3] * pitch);
    env(tail.g.gain, ring, 0.28 * vol, 0.01, 0.55);
    start(tail, ring, ring + 0.6);
    var fifth = oscPart(v, 'sine', notes[3] * pitch * 1.5);
    env(fifth.g.gain, ring, 0.14 * vol, 0.01, 0.45);
    start(fifth, ring, ring + 0.55);
    return dur;
  }

  // 'craft' - metallic clink: inharmonic partials with a bright tick.
  function sCraft(v, t0, pitch, vol) {
    var dur = 0.42;
    var f = 1180 * pitch;
    var ratios = [1, 2.31, 3.71, 5.14];
    var peaks = [0.24, 0.16, 0.11, 0.07];
    var decs = [0.22, 0.17, 0.12, 0.08];
    for (var i = 0; i < ratios.length; i++) {
      var o = oscPart(v, 'square', f * ratios[i]);
      env(o.g.gain, t0, peaks[i] * vol, 0.001, decs[i]);
      start(o, t0, t0 + 0.01 + decs[i] + 0.03);
    }
    var n = noisePart(v);
    filterPart(v, n.g, 'highpass', 3200 * pitch, 1.2);
    env(n.g.gain, t0, 0.2 * vol, 0.001, 0.03);
    start(n, t0, t0 + 0.07);
    return dur;
  }

  // 'deny' - flat buzz: two detuned squares behind a lowpass gate.
  function sDeny(v, t0, pitch, vol) {
    var dur = 0.2;
    var a = oscPart(v, 'square', 112 * pitch);
    var b = oscPart(v, 'square', 119 * pitch);
    var f = filterPart(v, a.g, 'lowpass', 900 * pitch, 1.4);
    try { b.g.disconnect(); b.g.connect(f); } catch (e) { /* keep direct path */ }
    envHold(a.g.gain, t0, 0.22 * vol, 0.008, 0.11, 0.05);
    envHold(b.g.gain, t0, 0.16 * vol, 0.008, 0.11, 0.05);
    start(a, t0, t0 + dur);
    start(b, t0, t0 + dur);
    return dur;
  }

  // 'ui' - tiny click: short noise tick plus a pitch pop.
  function sUi(v, t0, pitch, vol) {
    var dur = 0.14;
    var n = noisePart(v);
    filterPart(v, n.g, 'highpass', 1600 * pitch, 1.0);
    env(n.g.gain, t0, 0.18 * vol, 0.001, 0.04);
    start(n, t0, t0 + dur);

    var o = oscPart(v, 'sine', 1000 * pitch);
    sweep(o.o.frequency, t0, 1000 * pitch, 660 * pitch, 0.05);
    env(o.g.gain, t0, 0.16 * vol, 0.001, 0.085);
    start(o, t0, t0 + dur);
    return dur;
  }

  var LIBRARY = {
    place: sPlace,
    release: sRelease,
    harvest: sHarvest,
    attack: sAttack,
    hit: sHit,
    crit: sCrit,
    hurt: sHurt,
    die: sDie,
    levelup: sLevelup,
    craft: sCraft,
    deny: sDeny,
    ui: sUi
  };

  /* ------------------------------------------------------------------ *
   * public API
   * ------------------------------------------------------------------ */

  function play(name, opts) {
    try {
      if (!enabled) return false;
      if (!ctx) return false;                 // not initialised yet: silent no-op
      if (typeof ctx.state === 'string' && ctx.state === 'closed') return false;
      var builder = LIBRARY[name];
      if (typeof builder !== 'function') return false;  // unknown name: never throws

      var o = opts || {};
      var v = typeof o.volume === 'number' && isFinite(o.volume) ? o.volume : 1;
      var p = typeof o.pitch === 'number' && isFinite(o.pitch) ? o.pitch : 1;
      var pan = typeof o.pan === 'number' && isFinite(o.pan) ? clamp(o.pan, -1, 1) : 0;

      // Slight per-call wobble so repeats do not sound robotic.
      v = clamp(v, 0, 4) * (0.92 + Math.random() * 0.16);
      p = clamp(p, 0.25, 4) * (0.98 + Math.random() * 0.04);

      var t0 = now();
      var voice = newVoice(pan);
      var dur = builder(voice, t0, p, v);
      voice.end = t0 + (typeof dur === 'number' && dur > 0 ? dur : 0.5) + 0.05;
      return true;
    } catch (e) {
      return false;   // play() must never throw, whatever the caller does
    }
  }

  function isSupported() {
    return !!audioCtor();
  }

  function state() {
    if (!ctx) return 'uninitialised';
    return typeof ctx.state === 'string' ? ctx.state : 'unknown';
  }

  var SFX = {
    init: init,
    unlock: unlock,
    enable: enable,
    disable: disable,
    setVolume: setVolume,
    play: play,
    // extras, safe to ignore
    isSupported: isSupported,
    state: state,
    sounds: ['place', 'release', 'harvest', 'attack', 'hit', 'crit', 'hurt', 'die', 'levelup', 'craft', 'deny', 'ui']
  };

  if (global) global.SFX = SFX;
  if (typeof window !== 'undefined') window.SFX = SFX;
}(typeof window !== 'undefined' ? window : null));
