// sfx.js — sound effects for "ใครคือคนร้าย", synthesized from code: no samples, no AI audio, no files from other games.
// VreKi 2026-10-28: sounds in the familiar spirit of space party games, made from scratch — no files from any other game.
// v2 (oscillator beeps) → 8/13 ไม่ชอบ, every sound tagged "เหมือนเสียงคอม/เกมเก่า". v3 rebuilds them from physical-ish parts:
// noise-excited resonator banks (metal, wood, bells, drum skins), detuned ensembles (strings, brass), multi-band air —
// and sets levels by loudness (300 ms RMS) instead of peak ("ดังไป" on report/emergency/crew-win, "เบาไป" on meeting/talk/ambient).
// Two takes (_a/_b) per sound for VreKi to pick; PICK holds what the viewer plays.
// One file for both sides: the browser (window.SFX, viewer + review page) and node (make_sfx.js writes WAVs for the edit).
(function (root) {
  'use strict';
  const SR = 48000, TAU = Math.PI * 2;
  const len = (sec) => Math.ceil(sec * SR);

  // deterministic noise (xorshift) so every render is identical
  function rng(seed) { let s = (Math.floor(seed * 7919) >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }
  // polyBLEP band-limited oscillator; f(t) = frequency in Hz at time t (sec)
  function blep(p, dt) { if (p < dt) { p /= dt; return p + p - p * p - 1; } if (p > 1 - dt) { p = (p - 1) / dt; return p * p + p + p + 1; } return 0; }
  function osc(type, f, ph = 0) {
    return (t) => {
      const fr = f(t), dt = Math.min(0.5, Math.abs(fr) / SR);
      ph += fr / SR; ph -= Math.floor(ph);
      if (type === 'sine') return Math.sin(TAU * ph);
      if (type === 'tri') return 1 - 4 * Math.abs(ph - 0.5);
      if (type === 'saw') return 2 * ph - 1 - blep(ph, dt);
      return (ph < 0.5 ? 1 : -1) + blep(ph, dt) - blep((ph + 0.5) % 1, dt); // square
    };
  }
  // RBJ biquad; cutoff/q may change every call (coefficients refreshed every 32 samples)
  function biquad(type) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0, b1, b2, a1, a2, n = 0;
    function set(f, q) {
      const w = TAU * Math.max(20, Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
      let B0, B1, B2;
      if (type === 'lp') { B0 = (1 - c) / 2; B1 = 1 - c; B2 = B0; }
      else if (type === 'hp') { B0 = (1 + c) / 2; B1 = -(1 + c); B2 = B0; }
      else { B0 = al; B1 = 0; B2 = -al; } // band-pass, 0 dB peak
      b0 = B0 / a0; b1 = B1 / a0; b2 = B2 / a0; a1 = -2 * c / a0; a2 = (1 - al) / a0;
    }
    return (x, f, q = 0.707) => {
      if ((n++ & 31) === 0) set(f, q);
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; return y;
    };
  }
  const dec = (t, tau) => (t < 0 ? 0 : Math.exp(-t / tau));            // exponential decay from t = 0
  const atk = (t, a) => (t < 0 ? 0 : t < a ? t / a : 1);                // linear attack
  // hold at 1 until h, then decay — v2/v3-first-render used dec(t - h) here, which is 0 before h: the opening of kill/report/eject/vent was silent
  const holdDec = (t, h, tau) => (t < h ? 1 : Math.exp(-(t - h) / tau));
  const sweep = (a, b, t, T) => a * Math.pow(b / a, Math.min(1, Math.max(0, t / T))); // exponential glide a → b over T
  const cents = (c) => Math.pow(2, c / 1200);

  // render fn(t) into its own buffer, peak-normalize it to `gain`, mix into b at `at` — so layer levels read as written
  // (the last `release` sec fade to 0: v1 spectrograms showed a click wherever a layer was cut before its envelope died)
  function layer(b, at, dur, fn, gain = 1, release = 0.015) {
    const n = len(dur), tmp = new Float32Array(n), rel = Math.max(1, len(release)); let m = 0;
    for (let i = 0; i < n; i++) { let v = fn(i / SR); if (n - i < rel) v *= (n - i) / rel; tmp[i] = v; if (Math.abs(v) > m) m = Math.abs(v); }
    const g = m > 0 ? gain / m : 0, i0 = Math.round(at * SR), vis = Math.min(n, b.length - i0), fo = Math.min(vis, len(0.08));
    for (let i = 0; i < vis; i++) b[i0 + i] += tmp[i] * g * (vis < n && vis - i < fo ? (vis - i) / fo : 1); // cut by the buffer end → 80 ms fade
  }
  // resonator bank (modal synthesis): modes = [[Hz, decay sec, gain]] — what makes metal / wood / skins / bells sound physical
  function bank(modes) {
    const ms = modes.map(([f, tau, g]) => { const q = Math.max(0.6, Math.PI * f * tau); return { bp: biquad('bp'), f, q, g: g * q }; });
    return (x) => { let s = 0; for (const m of ms) s += m.bp(x, m.f, m.q) * m.g; return s; };
  }
  const modes = (f0, ratios, taus, gains) => ratios.map((k, i) => [f0 * k, taus[Math.min(i, taus.length - 1)], gains ? gains[i] : 1 / (1 + i * 0.6)]);
  const PLATE = [1, 1.94, 2.44, 3.16, 4.03, 4.64, 5.4, 6.3];   // metal plate (inharmonic)
  const SKIN = [1, 1.5, 1.98, 2.44, 2.92];                       // drum membrane
  const BELL = [1, 2.76, 5.4, 8.93];                             // glockenspiel bar
  const WOOD = [1, 2.57, 4.2, 6.1];                              // wood block
  // strike a bank with a short noise "mallet": exc = mallet length, soft = mallet low-pass (lower = softer, fewer highs)
  function strike(b, at, ms, { exc = 0.004, soft = 6000, gain = 1, dur, seed = 1 } = {}) {
    const r = rng(seed), bk = bank(ms), lp = biquad('lp'), d = dur || Math.min(3, Math.max(...ms.map((m) => m[1])) * 6);
    layer(b, at, d, (t) => bk(lp(t < exc ? r() * (1 - t / exc) : 0, soft)), gain, 0.04);
  }
  // detuned ensemble (strings / brass section): n voices, ± spread cents, slow random drift — the opposite of a lone chip tone
  function ens(f, { n = 7, spread = 14, type = 'saw', seed = 1, drift = 3 } = {}) {
    const r = rng(seed), vs = [];
    for (let i = 0; i < n; i++) {
      const d = (n === 1 ? 0 : (i / (n - 1)) * 2 - 1) * spread + r() * 2, rate = 0.2 + Math.abs(r()) * 0.4, ph = Math.abs(r());
      vs.push(osc(type, (t) => f(t) * cents(d + drift * Math.sin(TAU * rate * t + ph * 6)), ph));
    }
    return (t) => { let s = 0; for (const v of vs) s += v(t); return s / Math.sqrt(n); };
  }
  // brass section note: pitch scoops up, filter opens on the attack then closes, a little breath noise
  function brass(b, at, f, dur, { gain = 1, bright = 2800, seed = 1, hold } = {}) {
    const e = ens((t) => f * (1 - 0.035 * dec(t, 0.03)), { n: 5, spread: 9, seed }), lp = biquad('lp'), bp = biquad('bp'), r = rng(seed + 50);
    const h = hold == null ? dur * 0.4 : hold;
    layer(b, at, dur, (t) => { const env = atk(t, 0.014) * (t < h ? 1 : dec(t - h, 0.18));
      return (lp(e(t), 320 + bright * atk(t, 0.035) * (0.45 + 0.55 * holdDec(t, 0.035, 0.35)), 0.9) + bp(r(), 1400, 1.2) * 0.12) * env; }, gain);
  }
  // string section note: slow bow attack, vibrato, warm low-pass
  function strings(b, at, f, dur, { gain = 1, attack = 0.25, release = 0.6, seed = 1, trem = 0 } = {}) {
    const e = ens((t) => f * cents(7 * Math.sin(TAU * 5.3 * t) * atk(t, 0.4)), { n: 9, spread: 16, seed }), lp = biquad('lp');
    layer(b, at, dur + release, (t) => lp(e(t), 2400, 0.7) * atk(t, attack) * (t < dur ? 1 : dec(t - dur, release / 3)) * (trem ? 0.75 + 0.25 * Math.sin(TAU * trem * t) : 1), gain);
  }
  // band-limited air: noise through a moving band-pass (whooshes, hiss, swishes)
  function air(b, at, dur, f0, f1, { q = 1.2, gain = 1, seed = 1, env } = {}) {
    const r = rng(seed), bp = biquad('bp');
    layer(b, at, dur, (t) => bp(r(), sweep(f0, f1, t, dur), q) * (env ? env(t) : Math.sin(Math.PI * Math.min(1, t / dur))), gain);
  }

  // Freeverb-style mono reverb (8 combs + 4 all-pass): a metal room, not a dry computer
  function reverb(x, mix = 0.25, room = 0.84, damp = 0.3, tail = 1.2) {
    const n = x.length + len(tail), out = new Float32Array(n), sc = SR / 44100;
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((L) => ({ b: new Float32Array(Math.round(L * sc)), i: 0, f: 0 }));
    const aps = [556, 441, 341, 225].map((L) => ({ b: new Float32Array(Math.round(L * sc)), i: 0 }));
    for (let k = 0; k < n; k++) {
      const dry = k < x.length ? x[k] : 0, inp = dry * 0.015;
      let s = 0;
      for (const c of combs) { const y = c.b[c.i]; c.f = y * (1 - damp) + c.f * damp; c.b[c.i] = inp + c.f * room; c.i = (c.i + 1) % c.b.length; s += y; }
      for (const a of aps) { const bo = a.b[a.i], y = bo - s; a.b[a.i] = s + bo * 0.5; a.i = (a.i + 1) % a.b.length; s = y; }
      out[k] = dry * (1 - mix * 0.5) + s * mix * 3;
    }
    return out;
  }
  const buf = (sec) => new Float32Array(len(sec));

  // loudness = loudest 300 ms RMS (dBFS); levels are set by this, not by peak
  function loudness(x) {
    const w = len(0.3); let acc = 0, best = 0;
    for (let i = 0; i < x.length; i++) { acc += x[i] * x[i]; if (i >= w) acc -= x[i - w] * x[i - w]; best = Math.max(best, acc / Math.min(w, i + 1)); }
    return 10 * Math.log10(best + 1e-12);
  }
  // to the target loudness, soft-limit peaks above 0.8 (never past 0.95), cut the silent tail, 6 ms fade-out
  function finish(x, target, trim = true) {
    const g = Math.pow(10, (target - loudness(x)) / 20);
    for (let i = 0; i < x.length; i++) { const v = x[i] * g, a = Math.abs(v); x[i] = a > 0.8 ? Math.sign(v) * (0.8 + 0.15 * Math.tanh((a - 0.8) / 0.15)) : v; }
    if (!trim) return x;
    let end = x.length; while (end > 1 && Math.abs(x[end - 1]) < 0.0008) end--;
    const y = x.slice(0, Math.min(x.length, end + len(0.01))), f = Math.min(y.length, len(0.006));
    for (let i = 0; i < f; i++) y[y.length - 1 - i] *= i / f;
    return y;
  }

  const SOUNDS = {
    // ---------- ฆ่า ----------
    kill_a() { // cartoon stab: knife swish → body thud → three wet squelches → string-section shriek
      const b = buf(1.2);
      air(b, 0, 0.09, 1800, 5200, { q: 1.6, gain: 0.5, seed: 1, env: (t) => atk(t, 0.012) * holdDec(t, 0.04, 0.02) });
      strike(b, 0.07, modes(95, SKIN, [0.13, 0.08, 0.06, 0.05, 0.04]), { exc: 0.007, soft: 1400, gain: 1, seed: 2 });
      [[0.08, 380, 0.5], [0.13, 520, 0.38], [0.19, 450, 0.28]].forEach(([at, f, g], i) => air(b, at, 0.07, f, f * 3.2, { q: 7, gain: g, seed: 3 + i, env: (t) => atk(t, 0.004) * dec(t, 0.02) }));
      [233.1, 246.9, 370].forEach((f, i) => strings(b, 0.07, f, 0.25, { gain: 0.2, attack: 0.008, release: 0.45, seed: 10 + i, trem: 13 }));
      return reverb(b, 0.22, 0.82, 0.35, 0.9);
    },
    kill_b() { // heavy and real: swish → meaty impact + bone crack → deep boom, no music
      const b = buf(1.4), r = rng(21), lp = biquad('lp'), hp = biquad('hp');
      air(b, 0, 0.1, 1200, 3600, { q: 1.3, gain: 0.45, seed: 20, env: (t) => atk(t, 0.015) * holdDec(t, 0.05, 0.025) });
      layer(b, 0.08, 0.06, (t) => lp(r(), 650) * dec(t, 0.012), 0.8);
      strike(b, 0.08, modes(72, SKIN, [0.2, 0.12, 0.08, 0.06, 0.05]), { exc: 0.01, soft: 900, gain: 1, seed: 22 });
      layer(b, 0.085, 0.02, (t) => hp(r(), 2200) * dec(t, 0.0025), 0.45);
      strike(b, 0.1, modes(46, [1, 1.5], [0.45, 0.3]), { exc: 0.012, soft: 400, gain: 0.7, seed: 23 });
      return reverb(b, 0.28, 0.86, 0.5, 1.1);
    },
    // ---------- พบศพ ----------
    report_a() { // orchestral brass hit (tense chord) + timpani + a breath of cymbal
      const b = buf(1.8), r = rng(31), hp = biquad('hp');
      [130.8, 196, 261.6, 311.1, 370].forEach((f, i) => brass(b, 0, f, 1.1, { gain: 0.32, seed: 30 + i, hold: 0.12 }));
      strike(b, 0, modes(65, SKIN, [0.7, 0.4, 0.3, 0.2, 0.15]), { exc: 0.009, soft: 1100, gain: 0.85, seed: 36 });
      layer(b, 0, 0.9, (t) => hp(r(), 5500) * atk(t, 0.004) * dec(t, 0.3), 0.14);
      return reverb(b, 0.32, 0.88, 0.3, 1.4);
    },
    report_b() { // suspense: air rushes in, low hit, strings shudder
      const b = buf(2.0);
      air(b, 0, 0.3, 700, 5000, { q: 0.9, gain: 0.45, seed: 40, env: (t) => Math.pow(t / 0.3, 2.5) });
      strike(b, 0.28, modes(58, SKIN, [0.6, 0.35, 0.25, 0.18, 0.12]), { exc: 0.01, soft: 900, gain: 1, seed: 41 });
      [110, 116.5, 164.8, 233.1].forEach((f, i) => strings(b, 0.28, f, 0.7, { gain: 0.26, attack: 0.01, release: 0.6, seed: 42 + i, trem: 14 }));
      return reverb(b, 0.3, 0.87, 0.35, 1.3);
    },
    // ---------- ปุ่มประชุมฉุกเฉิน ----------
    emergency_a() { // school/fire bell ringing fast, pitched lower and softened (v2 klaxon = แหลม บาดหู)
      const b = buf(2.4), r = rng(51), bk = bank(modes(470, [1, 2.0, 2.76, 4.07, 5.4], [0.5, 0.35, 0.25, 0.14, 0.09])), lp = biquad('lp'), lp2 = biquad('lp');
      layer(b, 0, 2.2, (t) => { const k = t * 15, ph = k - Math.floor(k), hit = t < 1.45 && ph < 0.06 ? r() * (1 - ph / 0.06) : 0;
        return lp2(bk(lp(hit, 2600)), 3500, 0.6); }, 1, 0.08);
      return reverb(b, 0.24, 0.84, 0.4, 1.0);
    },
    emergency_b() { // low ship horn, two warm blasts
      const b = buf(2.0);
      for (const at of [0, 0.72]) [110, 164.8, 220].forEach((f, i) => brass(b, at, f, 0.62, { gain: 0.36, bright: 1500, seed: 60 + i + at * 10, hold: 0.45 }));
      return reverb(b, 0.28, 0.86, 0.4, 1.0);
    },
    emergency_c() { // v4: warm low siren "whoop whoop" into the report_b hit (report_b = ชอบมาก) — no bell, no shrill
      const b = buf(2.8), lp = biquad('lp');
      const e = ens((t) => 196 * Math.pow(2, (t % 0.45) / 0.45), { n: 6, spread: 10, seed: 301 });
      layer(b, 0, 0.92, (t) => lp(e(t), 900 + 900 * ((t % 0.45) / 0.45), 0.8) * atk(t, 0.03) * (t > 0.85 ? 1 - (t - 0.85) / 0.07 : 1), 0.55);
      air(b, 0.62, 0.3, 700, 5000, { q: 0.9, gain: 0.35, seed: 302, env: (t) => Math.pow(t / 0.3, 2.5) });
      strike(b, 0.9, modes(58, SKIN, [0.6, 0.35, 0.25, 0.18, 0.12]), { exc: 0.01, soft: 900, gain: 1, seed: 303 });
      [123.5, 130.8, 185, 261.6].forEach((f, i) => strings(b, 0.9, f, 0.7, { gain: 0.26, attack: 0.01, release: 0.6, seed: 304 + i, trem: 14 }));
      return reverb(b, 0.3, 0.87, 0.35, 1.3);
    },
    emergency_d() { // v4: timpani roll that swells into a big hit + low brass + shuddering strings
      const b = buf(2.6), r = rng(311), hp = biquad('hp');
      for (let i = 0; i < 20; i++) strike(b, i * 0.035, modes(72 + (i % 2) * 3, SKIN, [0.12, 0.08, 0.06, 0.05, 0.04]), { exc: 0.006, soft: 1200, gain: 0.12 + 0.5 * (i / 19), seed: 320 + i });
      layer(b, 0, 0.72, (t) => hp(r(), 4000) * Math.pow(t / 0.72, 2), 0.16);
      strike(b, 0.72, modes(50, SKIN, [0.8, 0.45, 0.3, 0.2, 0.15]), { exc: 0.012, soft: 800, gain: 1, seed: 341 });
      [98, 146.8, 196].forEach((f, i) => brass(b, 0.72, f, 0.5, { gain: 0.3, bright: 1800, seed: 342 + i, hold: 0.1 }));
      [116.5, 123.5, 174.6].forEach((f, i) => strings(b, 0.72, f, 0.6, { gain: 0.22, attack: 0.01, release: 0.6, seed: 346 + i, trem: 14 }));
      return reverb(b, 0.3, 0.87, 0.35, 1.3);
    },
    // ---------- เปิดห้องประชุม ----------
    meeting_a() { // judge's gavel on a wooden table, three knocks, bright (v2 thud = ทุ้มอู้อี้ เบาไป)
      const b = buf(1.0);
      [[0, 0.75], [0.15, 0.8], [0.3, 1]].forEach(([at, g], i) => {
        strike(b, at, modes(430 + i * 6, WOOD, [0.075, 0.04, 0.025, 0.018]), { exc: 0.0015, soft: 9000, gain: g, seed: 70 + i });
        strike(b, at, modes(150, [1, 1.7], [0.07, 0.04]), { exc: 0.003, soft: 2000, gain: g * 0.35, seed: 74 + i });
      });
      return reverb(b, 0.18, 0.78, 0.4, 0.6);
    },
    meeting_b() { // whoosh in, then a hand slapped on the table
      const b = buf(1.1), r = rng(81), hp = biquad('hp');
      air(b, 0, 0.24, 400, 2600, { q: 1.1, gain: 0.5, seed: 80, env: (t) => Math.pow(t / 0.24, 2) });
      strike(b, 0.23, modes(230, WOOD, [0.12, 0.06, 0.035, 0.02]), { exc: 0.004, soft: 5000, gain: 1, seed: 82 });
      strike(b, 0.23, modes(92, SKIN, [0.16, 0.1, 0.07, 0.05, 0.04]), { exc: 0.006, soft: 1500, gain: 0.6, seed: 83 });
      layer(b, 0.23, 0.02, (t) => hp(r(), 2500) * dec(t, 0.003), 0.4);
      return reverb(b, 0.2, 0.8, 0.4, 0.7);
    },
    meeting_c() { // v4: six paper cards slapped onto the board one after another (the ink/paper look of the meeting grid)
      const b = buf(0.9);
      for (let i = 0; i < 6; i++) {
        const r = rng(401 + i), bp = biquad('bp'), last = i === 5;
        layer(b, i * 0.05, 0.08, (t) => bp(r(), 1800 + 160 * i, 1.2) * atk(t, 0.002) * dec(t, 0.018), last ? 0.85 : 0.6);
        strike(b, i * 0.05, modes(140, SKIN, [0.05, 0.035, 0.03, 0.025, 0.02]), { exc: 0.003, soft: 2500, gain: last ? 0.4 : 0.25, seed: 410 + i });
      }
      return reverb(b, 0.16, 0.76, 0.45, 0.5);
    },
    meeting_d() { // v4: suspense "dun · dun · dunnn" — strings + low brass + timpani stepping down a semitone each time
      const b = buf(2.2);
      [[0, 146.8, 0.12], [0.22, 138.6, 0.12], [0.44, 130.8, 0.6]].forEach(([at, f, d], i) => {
        strings(b, at, f, d, { gain: 0.4, attack: 0.008, release: 0.3, seed: 420 + i, trem: i === 2 ? 12 : 0 });
        brass(b, at, f / 2, d + 0.15, { gain: 0.3, bright: 1400, seed: 430 + i, hold: d });
        strike(b, at, modes(f / 2, SKIN, [0.35, 0.22, 0.15, 0.1, 0.08]), { exc: 0.008, soft: 1000, gain: 0.5, seed: 440 + i });
      });
      return reverb(b, 0.32, 0.87, 0.35, 1.2);
    },
    // ---------- คำพูดขึ้น (pitch per character) ----------
    talk_a(o = {}) { // v2 pop (liked), only louder now
      const p = o.pitch || 1, b = buf(0.12), s = osc('sine', (t) => sweep(480 * p, 920 * p, t, 0.05)), hp = biquad('hp'), r = rng(41);
      layer(b, 0, 0.1, (t) => s(t) * atk(t, 0.003) * dec(t, 0.028) + hp(r(), 4000) * dec(t, 0.002) * 0.25, 1);
      return b;
    },
    talk_b(o = {}) { // soft bubble "bloop": a resonant noise pop instead of a sine
      const p = o.pitch || 1, b = buf(0.13), r = rng(43), bp = biquad('bp'), hp = biquad('hp');
      layer(b, 0, 0.11, (t) => bp(t < 0.006 ? r() * (1 - t / 0.006) : 0, sweep(650 * p, 1250 * p, t, 0.05), 32) + hp(t < 0.0015 ? r() : 0, 3000) * 0.02, 1); // q 32 ≈ 10 ms ring (q 9 was a click)
      return b;
    },
    // ---------- โหวต ----------
    vote_a() { // button click + bright pop
      const b = buf(0.2), r = rng(91), hp = biquad('hp'), bp = biquad('bp');
      layer(b, 0, 0.02, (t) => hp(r(), 3000) * dec(t, 0.0015), 0.55);
      layer(b, 0.012, 0.12, (t) => bp(t < 0.003 ? r() : 0, sweep(1400, 2400, t, 0.025), 8), 1);
      return reverb(b, 0.1, 0.7, 0.5, 0.3);
    },
    vote_b() { // rubber stamp on paper, brighter and lighter than v2
      const b = buf(0.3), r = rng(95), bp = biquad('bp');
      strike(b, 0, modes(300, [1, 2.3, 3.9], [0.05, 0.03, 0.02]), { exc: 0.003, soft: 4000, gain: 0.8, seed: 96 });
      layer(b, 0, 0.06, (t) => bp(r(), 2200, 0.9) * dec(t, 0.022), 0.6);
      return reverb(b, 0.12, 0.7, 0.5, 0.3);
    },
    // ---------- โยนออก ----------
    eject_a() { // airlock: metal latch clunk → pressurised hiss → body sucked away in three air bands → quiet space
      const b = buf(4.2), r = rng(101), hp = biquad('hp'), lp = biquad('lp');
      strike(b, 0, modes(110, PLATE, [0.3, 0.22, 0.16, 0.12, 0.09, 0.07, 0.05, 0.04]), { exc: 0.005, soft: 2500, gain: 0.75, seed: 102 });
      layer(b, 0.05, 0.55, (t) => hp(r(), 2500) * atk(t, 0.05) * (1 + 0.3 * Math.sin(TAU * 23 * t)), 0.32);
      [[2600, 300, 1.2, 0.9], [1800, 220, 1.5, 0.75], [900, 120, 1.0, 0.7]].forEach(([f0, f1, q, g], i) =>
        air(b, 0.45 + i * 0.06, 1.7, f0, f1, { q, gain: g, seed: 103 + i, env: (t) => atk(t, 0.12) * holdDec(t, 0.25, 0.45) }));
      layer(b, 1.4, 2.6, (t) => lp(r(), 140) * atk(t, 0.7) * (t > 1.6 ? 1 - (t - 1.6) / 1.0 : 1), 0.18);
      return reverb(b, 0.35, 0.9, 0.3, 1.5);
    },
    eject_b() { // body bumps the door, one long suck of air
      const b = buf(3.4);
      strike(b, 0, modes(80, SKIN, [0.15, 0.1, 0.07, 0.05, 0.04]), { exc: 0.008, soft: 1200, gain: 0.7, seed: 111 });
      [[3200, 180, 1.0, 1], [1500, 140, 1.4, 0.8]].forEach(([f0, f1, q, g], i) =>
        air(b, 0.1 + i * 0.05, 2.4, f0, f1, { q, gain: g, seed: 112 + i, env: (t) => atk(t, 0.25) * holdDec(t, 0.5, 0.6) }));
      return reverb(b, 0.38, 0.9, 0.3, 1.5);
    },
    // ---------- มุดท่อ ----------
    vent_a() { // big sheet-metal hatch: open clank, scrape, close — pitched low, soft mallet (v2 = แหลม บาดหู)
      const b = buf(1.1);
      strike(b, 0, modes(170, PLATE, [0.3, 0.22, 0.18, 0.14, 0.1, 0.08, 0.06, 0.05]), { exc: 0.005, soft: 2400, gain: 1, seed: 121 });
      const r = rng(122), bp = biquad('bp');
      layer(b, 0.08, 0.3, (t) => bp(r(), 800 + 200 * Math.sin(TAU * 9 * t), 1.4) * Math.sin(Math.PI * t / 0.3), 0.35);
      strike(b, 0.42, modes(150, PLATE, [0.25, 0.18, 0.14, 0.1, 0.08, 0.06, 0.05, 0.04]), { exc: 0.005, soft: 2000, gain: 0.75, seed: 123 });
      return reverb(b, 0.16, 0.75, 0.45, 0.6);
    },
    vent_b() { // sucked down the duct, lid shuts with a dull thunk
      const b = buf(1.0);
      air(b, 0, 0.32, 1500, 250, { q: 1.3, gain: 0.8, seed: 131, env: (t) => atk(t, 0.04) * holdDec(t, 0.12, 0.08) });
      strike(b, 0.3, modes(120, PLATE, [0.18, 0.12, 0.09, 0.07, 0.05, 0.04, 0.03, 0.03]), { exc: 0.006, soft: 1200, gain: 1, seed: 132 });
      return reverb(b, 0.15, 0.75, 0.5, 0.5);
    },
    // ---------- ภารกิจเสร็จ ----------
    task_done_a() { // glockenspiel "ding-ding"
      const b = buf(1.4);
      [[0, 1046.5], [0.09, 1568]].forEach(([at, f], i) => strike(b, at, modes(f, BELL, [0.9, 0.35, 0.15, 0.08], [1, 0.4, 0.2, 0.1]), { exc: 0.002, soft: 7000, gain: 0.8, seed: 141 + i }));
      return reverb(b, 0.25, 0.8, 0.4, 0.8);
    },
    task_done_b() { // marimba, three notes up
      const b = buf(1.0);
      [[0, 659.3], [0.07, 880], [0.14, 1108.7]].forEach(([at, f], i) => strike(b, at, modes(f, [1, 3.93, 9.1], [0.35, 0.1, 0.04], [1, 0.3, 0.1]), { exc: 0.003, soft: 5000, gain: 0.75, seed: 151 + i }));
      return reverb(b, 0.2, 0.78, 0.45, 0.6);
    },
    // ---------- ลูกเรือชนะ ----------
    win_crew_a() { // warm string swell (major) with a glockenspiel run on top — softer than v2
      const b = buf(3.2);
      [130.8, 164.8, 196, 261.6, 329.6, 392].forEach((f, i) => strings(b, 0, f, 1.8, { gain: 0.24, attack: 0.35, release: 0.9, seed: 160 + i }));
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => strike(b, 0.08 + i * 0.1, modes(f, BELL, [0.8, 0.3, 0.13, 0.07], [1, 0.4, 0.2, 0.1]), { exc: 0.002, soft: 7000, gain: 0.35, seed: 170 + i }));
      return reverb(b, 0.35, 0.88, 0.3, 1.5);
    },
    win_crew_b() { // brass "ta-da" (G → C) with timpani
      const b = buf(2.6);
      [196, 246.9, 293.7].forEach((f, i) => brass(b, 0, f, 0.22, { gain: 0.3, seed: 180 + i, hold: 0.12 }));
      [261.6, 329.6, 392, 523.3].forEach((f, i) => brass(b, 0.2, f, 1.5, { gain: 0.3, seed: 184 + i, hold: 0.9 }));
      strike(b, 0.2, modes(65, SKIN, [0.6, 0.35, 0.25, 0.18, 0.12]), { exc: 0.009, soft: 1100, gain: 0.6, seed: 189 });
      return reverb(b, 0.32, 0.87, 0.3, 1.4);
    },
    // ---------- คนร้ายชนะ ----------
    win_imp_a() { // v2 (liked): boom + falling minor line over a low drone
      const b = buf(3.0), r = rng(97), lp0 = biquad('lp'), boom = osc('sine', (t) => sweep(70, 30, t, 0.6));
      layer(b, 0, 1.2, (t) => boom(t) * dec(t, 0.4) + lp0(r(), 500) * dec(t, 0.06) * 0.8, 1);
      for (const [at, f] of [[0.15, 440], [0.5, 349.2], [0.85, 293.7], [1.2, 277.2]]) {
        const o = osc('saw', () => f), o2 = osc('saw', () => f * cents(7)), lp = biquad('lp');
        layer(b, at, 1.6, (t) => lp(o(t) + o2(t), sweep(2200, 500, t, 1.2)) * atk(t, 0.01) * dec(t, at > 1 ? 0.7 : 0.3), 0.45);
      }
      const d = osc('saw', () => 55), lpd = biquad('lp');
      layer(b, 0, 2.9, (t) => lpd(d(t), 260) * atk(t, 0.4) * (t > 2.2 ? 1 - (t - 2.2) / 0.7 : 1), 0.6);
      return reverb(b, 0.35, 0.86, 0.3, 1.2);
    },
    win_imp_b() { // same line, played by a dark string + brass section over a timpani boom
      const b = buf(3.4), r = rng(201), lp0 = biquad('lp');
      strike(b, 0, modes(52, SKIN, [0.8, 0.45, 0.3, 0.2, 0.15]), { exc: 0.012, soft: 700, gain: 1, seed: 202 });
      layer(b, 0, 0.3, (t) => lp0(r(), 500) * dec(t, 0.06), 0.4);
      [[0.15, 440], [0.5, 349.2], [0.85, 293.7], [1.2, 277.2]].forEach(([at, f], i) => {
        strings(b, at, f, at > 1 ? 1.2 : 0.32, { gain: 0.42, attack: 0.03, release: 0.5, seed: 210 + i });
        brass(b, at, f / 2, at > 1 ? 1.4 : 0.4, { gain: 0.22, bright: 1200, seed: 220 + i });
      });
      strings(b, 0, 55, 2.4, { gain: 0.3, attack: 0.4, release: 0.6, seed: 230 });
      return reverb(b, 0.36, 0.88, 0.3, 1.4);
    },
    // ---------- game 2 (VreKi 2026-10-28) · built the v3 way (resonators, ensembles, air), never bare beeps ----------
    shot() { // the captain's gun: sharp crack + chest-deep boom + a short room tail
      const b = buf(1.4), r = rng(501), hp = biquad('hp'), lp = biquad('lp');
      layer(b, 0, 0.05, (t) => hp(r(), 1500) * dec(t, 0.006), 1);
      strike(b, 0, modes(68, SKIN, [0.22, 0.14, 0.1, 0.07, 0.05]), { exc: 0.004, soft: 2500, gain: 0.9, seed: 502 });
      layer(b, 0.01, 0.9, (t) => lp(r(), sweep(3000, 300, t, 0.6)) * dec(t, 0.18), 0.45);
      return reverb(b, 0.3, 0.86, 0.35, 1.2);
    },
    collect() { // the สัปเหร่อ drags a body away: a soft thud, then cloth scraping over metal
      const b = buf(1.6), r = rng(511), bp = biquad('bp');
      strike(b, 0, modes(110, SKIN, [0.16, 0.1, 0.07, 0.05, 0.04]), { exc: 0.008, soft: 1200, gain: 0.7, seed: 512 });
      layer(b, 0.15, 1.2, (t) => bp(r(), 380 + 120 * Math.sin(TAU * 3.2 * t), 1.6) * (0.55 + 0.45 * Math.abs(Math.sin(TAU * 2.4 * t))) * Math.sin(Math.PI * t / 1.2), 0.8);
      return reverb(b, 0.18, 0.78, 0.45, 0.6);
    },
    shadow() { // ม่านเงา: lights die — strings slide down into a low hit, air sucked out
      const b = buf(2.6);
      air(b, 0, 0.5, 4000, 400, { q: 0.9, gain: 0.4, seed: 521, env: (t) => Math.sin(Math.PI * Math.min(1, t / 0.5)) });
      [220, 233.1, 329.6].forEach((f, i) => { const e = ens((t) => f * Math.pow(0.5, Math.min(1, t / 1.1)), { n: 7, spread: 14, seed: 522 + i }), lp = biquad('lp');
        layer(b, 0, 1.6, (t) => lp(e(t), sweep(2400, 500, t, 1.4), 0.8) * atk(t, 0.02) * holdDec(t, 0.8, 0.4), 0.3); });
      strike(b, 0.9, modes(48, SKIN, [0.7, 0.4, 0.3, 0.2, 0.15]), { exc: 0.012, soft: 700, gain: 1, seed: 526 });
      return reverb(b, 0.34, 0.88, 0.3, 1.4);
    },
    // v6 (VreKi: take A "เหมือนเสียงคอม/เกมเก่า" — the saw glide down is the arcade "power off") · no pitch glides here
    shadow_b() { // ไฟดับทั้งยาน: a big breaker clunks, relays click off down the station, the metal hull booms and the hum is gone
      const b = buf(2.8), r = rng(531), lp = biquad('lp');
      strike(b, 0, modes(180, PLATE, [0.09, 0.07, 0.05, 0.04, 0.03, 0.03, 0.02, 0.02]), { exc: 0.003, soft: 3500, gain: 0.8, seed: 532 }); // breaker lever
      strike(b, 0.02, modes(95, WOOD, [0.08, 0.05, 0.03, 0.02]), { exc: 0.004, soft: 2000, gain: 0.6, seed: 533 });
      [0.16, 0.27, 0.36, 0.44, 0.51].forEach((at, i) => strike(b, at, modes(900 - i * 90, PLATE, [0.02, 0.015, 0.012, 0.01, 0.008, 0.006, 0.005, 0.004]),
        { exc: 0.0015, soft: 7000, gain: 0.32 - i * 0.04, seed: 534 + i })); // relays, further and further away
      strike(b, 0.56, modes(62, PLATE, [1.4, 1.0, 0.8, 0.6, 0.45, 0.35, 0.28, 0.22]), { exc: 0.02, soft: 900, gain: 1, seed: 540 }); // the hull (62 Hz: still heard on phone speakers)
      layer(b, 0.56, 2.1, (t) => lp(r(), 140, 0.7) * dec(t, 0.7) * atk(t, 0.03), 0.6); // low rumble under it
      return reverb(b, 0.36, 0.9, 0.35, 1.6);
    },
    shadow_c() { // ม่านดำคลุม: a heavy curtain swept across, a timpani hit, a still and dark low-string cluster with tremolo
      const b = buf(3.0);
      air(b, 0, 0.75, 260, 900, { q: 0.8, gain: 0.55, seed: 551, env: (t) => atk(t, 0.25) * holdDec(t, 0.45, 0.2) }); // cloth whoosh, low
      air(b, 0.05, 0.7, 1200, 2600, { q: 1.4, gain: 0.18, seed: 552, env: (t) => atk(t, 0.3) * holdDec(t, 0.4, 0.2) });
      strike(b, 0.62, modes(52, SKIN, [0.9, 0.55, 0.35, 0.25, 0.18]), { exc: 0.012, soft: 650, gain: 1, seed: 553 });
      [87.3, 92.5, 130.8, 138.6].forEach((f, i) => strings(b, 0.62, f, 1.3, { gain: 0.24, attack: 0.05, release: 0.9, seed: 554 + i, trem: 11 }));
      return reverb(b, 0.4, 0.9, 0.35, 1.6);
    },
    // ---------- เสียงในยาน (liked · เบาไป) ----------
    ambient() { // 8 s seamless loop: low hum + air (49/98 Hz and the 1/8 Hz swell complete whole cycles; noise is cross-faded)
      const T = 8, X = 1, b = buf(T + X), r = rng(113), lp = biquad('lp');
      const h1 = osc('sine', () => 49), h2 = osc('sine', () => 98), h3 = osc('sine', () => 147.5);
      for (let i = 0; i < b.length; i++) {
        const t = i / SR, sw = 0.75 + 0.25 * Math.sin(TAU * t / T);
        b[i] = (h1(t) * 0.5 + h2(t) * 0.22 + h3(t) * 0.05) * sw + lp(r(), 320 + 120 * Math.sin(TAU * t / T)) * 1.8 * sw;
      }
      const n = len(T), x = len(X), out = b.slice(0, n);
      for (let i = 0; i < x; i++) { const k = i / x; out[i] = b[n + i] * (1 - k) + b[i] * k; } // the tail flows into the head
      return out;
    },
  };

  // loudness targets (dBFS, loudest 300 ms) — from the v2 review: report/emergency/crew-win were too loud, meeting/talk/ambient too quiet
  const LEVEL = { kill: -16, report: -19, emergency: -19, meeting: -16, talk: -13, vote: -14, eject: -18, vent: -18, task_done: -19,
    win_crew: -20, win_imp: -18, ambient: -24, shot: -7, collect: -19, shadow: -13 }; // "เบาไป": shot -15 → -11 (v5) → -7 (v6) · shadow -18 → -13 (v6, take B)
  const BASE = (name) => name.replace(/_[a-d]$/, '');
  // which take the viewer plays — VreKi's reviews 2026-10-28: v3 (highest rating wins; talk A/B tied → A, liked since v2) +
  // v4 (emergency C and D both ชอบมาก → C, the siren reads as "emergency" · meeting D ชอบมาก, C เฉยๆ). All 12 sounds passed.
  const PICK = { kill: 'kill_a', report: 'report_b', emergency: 'emergency_c', meeting: 'meeting_d', talk: 'talk_a', vote: 'vote_a', eject: 'eject_a',
    vent: 'vent_b', task_done: 'task_done_b', win_crew: 'win_crew_a', win_imp: 'win_imp_b', ambient: 'ambient',
    shot: 'shot', collect: 'collect', shadow: 'shadow_b' }; // game 2 · v6 review: shadow = B ไฟดับทั้งยาน (A was "เหมือนเสียงคอม")
  const INFO = {
    kill_a: ['ฆ่า · A การ์ตูน', 'มีดเฉือนฉับ · กระแทกตัว · เสียงเละสั้นๆ 3 ที · เครื่องสายแหลมให้ตกใจ'],
    kill_b: ['ฆ่า · B หนักแบบจริง', 'มีดเฉือน · กระแทกเนื้อหนัก · เสียงกระดูก · บูมต่ำ ไม่มีดนตรี'],
    report_a: ['พบศพ · A แตรวง', 'แตรทั้งวงตีคอร์ดตึงๆ พร้อมกลองทิมปานี · เบากว่าเดิม'],
    report_b: ['พบศพ · B ลุ้นระทึก', 'ลมดูดขึ้นแล้วกระแทกต่ำ ตามด้วยเครื่องสายสั่นระรัว'],
    emergency_a: ['ปุ่มฉุกเฉิน · A กริ่งโลหะ', 'กริ่งรัวแบบกริ่งโรงเรียน เสียงต่ำลง ไม่แหลม เบากว่าเดิมมาก'],
    emergency_b: ['ปุ่มฉุกเฉิน · B แตรเรือ', 'แตรต่ำสองจังหวะ ทุ้มอุ่น'],
    emergency_c: ['ปุ่มฉุกเฉิน · C ไซเรนต่ำ + กระแทก', 'ไซเรนทุ้ม หวู้ หวู้ สองที แล้วกระแทกพร้อมเครื่องสายสั่น แบบเดียวกับพบศพ B ที่ชอบมาก'],
    emergency_d: ['ปุ่มฉุกเฉิน · D กลองรัว + กระแทก', 'กลองทิมปานีรัวดังขึ้นเรื่อยๆ แล้วกระแทกพร้อมแตรต่ำกับเครื่องสายสั่น'],
    meeting_c: ['เปิดห้องประชุม · C กระดาษตบบอร์ด', 'การ์ดกระดาษ 6 ใบตบลงบอร์ดทีละใบ เข้ากับภาพการ์ตูนหมึก-กระดาษ'],
    meeting_d: ['เปิดห้องประชุม · D ดัน ดัน ดันน์', 'เครื่องสาย แตรต่ำ กลอง ไล่ลงทีละครึ่งเสียง ให้ลุ้นว่าใครคือคนร้าย'],
    meeting_a: ['เปิดห้องประชุม · A ค้อนไม้', 'ค้อนตุลาการเคาะโต๊ะไม้ 3 ที เสียงใส ดังขึ้น'],
    meeting_b: ['เปิดห้องประชุม · B วูบแล้วตบโต๊ะ', 'ลมวูบเข้ามาแล้วตบโต๊ะไม้ดังปึ้ง'],
    talk_a: ['คำพูดขึ้น · A แบบเดิม ดังขึ้น', 'ป๊อปที่ชอบรอบที่แล้ว ปรับให้ดังขึ้นอย่างเดียว'],
    talk_b: ['คำพูดขึ้น · B ป๊อปนุ่ม', 'ป๊อปเหมือนฟองสบู่แตก ไม่ใช่เสียงคอม'],
    vote_a: ['โหวต · A คลิกป๊อป', 'กดปุ่มดังติ๊กแล้วป๊อปใส'],
    vote_b: ['โหวต · B ตรายางแบบใส', 'ตรายางกระแทกกระดาษ ทุ้มน้อยลง'],
    eject_a: ['โยนออก · A ประตูลม', 'กลอนเหล็กปลด · ลมรั่วฟู่ · ร่างถูกดูดหายไป · เงียบในอวกาศ'],
    eject_b: ['โยนออก · B ลมดูดล้วน', 'ตัวกระแทกประตู แล้วลมดูดยาวๆ'],
    vent_a: ['มุดท่อ · A ฝาเหล็กทุ้ม', 'ฝาเหล็กแผ่นใหญ่ เปิด-ครูด-ปิด เสียงต่ำ ไม่แหลม'],
    vent_b: ['มุดท่อ · B ดูดลงท่อ', 'ลมดูดลงท่อ แล้วฝาปิดดังตึ้บ'],
    task_done_a: ['ภารกิจเสร็จ · A ระฆังแก้ว', 'ติ๊ง-ติ๊ง สองโน้ตแบบกล็อคเคนสปีล'],
    task_done_b: ['ภารกิจเสร็จ · B ระนาดไม้', 'สามโน้ตไล่ขึ้นแบบมาริมบา'],
    win_crew_a: ['ลูกเรือชนะ · A เครื่องสายฉลอง', 'คอร์ดเครื่องสายอุ่นๆ ค่อยๆ ดังขึ้น มีระฆังไล่โน้ต เบากว่าเดิม'],
    win_crew_b: ['ลูกเรือชนะ · B แตรตาด้า', 'แตรสองคอร์ด ตา-ด้า กับกลองทิมปานี'],
    win_imp_a: ['คนร้ายชนะ · A แบบเดิม', 'อันที่ชอบรอบที่แล้ว ไม่ได้เปลี่ยน'],
    win_imp_b: ['คนร้ายชนะ · B วงเครื่องสายมืด', 'ทำนองเดิม เล่นด้วยเครื่องสายกับแตร ไม่เป็นเสียงคอม'],
    shot: ['ยิงปืน (กัปตัน)', 'เสียงปืนแตกดังเปรี้ยง ตามด้วยเสียงทุ้มและเสียงก้องในห้อง'],
    collect: ['ลากศพ (สัปเหร่อ)', 'ตุบเบาๆ แล้วเสียงผ้าครูดกับพื้นเหล็ก'],
    shadow_b: ['ม่านเงา · B ไฟดับทั้งยาน', 'สะพานไฟตัดดังกึก รีเลย์ดับไล่ไปทีละจุด แล้วตัวยานเหล็กครางทุ้มยาว · ไม่มีเสียงไถลลง'],
    shadow_c: ['ม่านเงา · C ม่านดำคลุม', 'เสียงผ้าม่านหนักกวาดผ่าน กลองทิมปานี แล้วเครื่องสายต่ำสั่นนิ่งๆ มืดๆ · ไม่มีเสียงไถลลง'],
    shadow: ['ม่านเงา (คนร้าย)','ลมดูด เครื่องสายไถลต่ำลง แล้วกระแทก เหมือนไฟดับทั้งยาน'],
    ambient: ['เสียงในยาน · ดังขึ้น', 'อันที่ชอบรอบที่แล้ว ดังขึ้นอย่างเดียว · วนต่อกันได้ไม่มีรอยต่อ'],
  };

  function render(name, opts) {
    const fn = SOUNDS[name]; if (!fn) throw new Error('no sound ' + name);
    return finish(fn(opts), LEVEL[BASE(name)] || -18, name !== 'ambient'); // the loop keeps its exact length
  }

  // 16-bit PCM mono WAV bytes (node and browser)
  function wav(x) {
    const n = x.length, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
    return new Uint8Array(ab);
  }

  // browser player: unlock on the first user gesture (autoplay rule), buffers rendered once; play('kill') resolves PICK
  function player() {
    let ctx = null, master = null, amb = null, on = true;
    const cache = {};
    const ready = () => !!ctx;
    const resolve = (name) => (SOUNDS[name] ? name : PICK[name] || name);
    function unlock() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
      ctx = new AC({ sampleRate: SR }); master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    }
    function bufOf(name, opts) {
      const key = name + (opts && opts.pitch ? '@' + opts.pitch : '');
      if (!cache[key]) { const x = render(name, opts), ab = ctx.createBuffer(1, x.length, SR); ab.copyToChannel(x, 0); cache[key] = ab; }
      return cache[key];
    }
    function play(name, opts = {}) {
      if (!ctx || !on) return null;
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = bufOf(resolve(name), opts); src.playbackRate.value = opts.rate || 1;
      g.gain.value = opts.gain == null ? 1 : opts.gain;
      src.connect(g); g.connect(master); src.start(); return src;
    }
    function ambient(want) {
      if (!ctx) return;
      if (want && on && !amb) { amb = play('ambient'); if (amb) amb.loop = true; }
      if ((!want || !on) && amb) { amb.stop(); amb = null; }
    }
    function toggle() { on = !on; if (!on) ambient(false); return on; }
    function warm(names) { if (ctx) for (const n of names) bufOf(resolve(n)); }
    return { unlock, play, ambient, toggle, warm, ready, get on() { return on; } };
  }

  const API = { SR, render, wav, player, names: Object.keys(SOUNDS), used: Object.values(PICK), PICK, INFO, LEVEL, BASE, loudness };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.SFX = API;
})(typeof window !== 'undefined' ? window : globalThis);
