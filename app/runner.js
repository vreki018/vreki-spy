'use strict';
// runner.js — plays one game of "ใครคือสายลับ?" inside the server (the clip's run.js loop without the command line).
// The timeline + stats are rewritten after every step (a turn, a checkpoint, the final vote), so the viewer can follow
// the game live. Spoken lines get their character voice as soon as they exist (<id>_voice/manifest.json, keyed by the
// line's index in the timeline, the same layout as the clip's voice files). A company that keeps failing stops the
// game with a Thai "halt" event.
const fs = require('fs');
const path = require('path');
const G = require('./game.js');
const A = require('./agent.js');
const { callProvider } = require('./providers');
const { explainError } = require('./detect');
const P = require('./paths');

const ID_RE = /^(w_[0-9_]+|clip_g[1-5])$/;
const ABORT_MESSAGE = 'หยุดเกมแล้ว';
const VOICED = ['ask', 'answer', 'accuse', 'defend', 'guess']; // the clip's voice set (vote reasons are read, not spoken)
const pad = (n, k = 2) => String(n).padStart(k, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// agent.js has one module-wide caller; every game hangs its own on its config (app.call), so an aborted game
// that is still finishing never borrows the next game's settings
A.setCaller((prov, cfg, app, req) => (app.call ? app.call(prov, cfg, app, req) : callProvider(prov, cfg, app, req)));

// w_YYYYMMDD_HHMMSS (local time) · taken already in outDir → _2, _3, …
function newId(outDir, now = new Date()) {
  const base = `w_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let id = base;
  for (let k = 2; fs.existsSync(path.join(outDir, id + '.json')); k++) id = `${base}_${k}`;
  return id;
}

class GameRun {
  // opts: { providers:{claude:2,…}|null, mock, mockDelay, seed?, voice:{say(char,text,out)}|null,
  //         voiceMode:'off'|'free'|'gemini', outDir, id?, callOverride? (tests only) }
  constructor(config, opts = {}) {
    const app = JSON.parse(JSON.stringify(config));
    this.app = app;
    this.mock = !!opts.mock;
    this.mockDelay = this.mock ? Math.max(0, +opts.mockDelay || 0) : 0;
    this.voice = opts.voice || null;
    this.voiceMode = opts.voiceMode || (this.voice ? 'free' : 'off');
    this.outDir = path.resolve(opts.outDir || P.LOGS);
    fs.mkdirSync(this.outDir, { recursive: true });
    if (opts.id != null && !ID_RE.test(opts.id)) throw new Error(`bad game id ${opts.id}`);
    this.id = opts.id || newId(this.outDir);
    this.file = path.join(this.outDir, this.id + '.json');
    this.statsFile = path.join(this.outDir, this.id + '.stats.json');
    this.voiceDir = path.join(this.outDir, this.id + '_voice');

    app.timeoutMs = (app.callTimeoutSec || 150) * 1000;
    if (!app.sandboxDir) app.sandboxDir = P.SANDBOX;
    app.stats = [];
    const override = opts.callOverride || null;
    // after abort() no AI is asked any more: every call fails at once, the loop writes the halt at its next step
    app.call = (prov, cfg, a, req) => (this.aborted ? Promise.resolve({ ok: false, ms: 0, error: 'aborted' }) : (override || callProvider)(prov, cfg, a, req));

    // seats: providers shuffled onto the cast (seeded, so a game can be repeated); the spy is dealt by game.js
    this.seed = opts.seed != null ? +opts.seed : Date.now() % 100000;
    const cast = (app.game && app.game.cast ? app.game.cast.map((id) => app.characters.find((c) => c.id === id)) : app.characters).filter(Boolean);
    const rng = G.makeRng(this.seed * 7 + 3);
    const providers = [];
    if (this.mock) for (let i = 0; i < cast.length; i++) providers.push('mock');
    else {
      if (!opts.providers || typeof opts.providers !== 'object') throw new Error('pick at least one company');
      for (const [prov, n] of Object.entries(opts.providers)) {
        if (!app.providers[prov]) throw new Error(`unknown company ${prov}`);
        for (let i = 0; i < n; i++) providers.push(prov);
      }
    }
    if (providers.length !== cast.length) throw new Error(`need ${cast.length} seats, got ${providers.length}`);
    for (let i = providers.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [providers[i], providers[j]] = [providers[j], providers[i]]; }
    this.seats = {};
    cast.forEach((c, i) => { this.seats[c.id] = { provider: providers[i], persona: c.persona }; });

    const k = app.game || {};
    this.g = G.createGame({ players: cast.map((c) => ({ id: c.id, name: c.name, seat: this.seats[c.id].provider })), seed: this.seed,
      spies: k.spies || 1, questions: k.questions || 12, checkEvery: k.checkEvery || 4, passRatio: k.passRatio || 0.75,
      lastGuess: k.lastGuess !== false, trialAt: k.trialAt || 3 });

    this.steps = [];
    this.running = false;
    this.done = false;
    this.halted = null;
    this.aborted = false;
    this.statsSeen = 0;
    this.failStreak = {}; // company → consecutive steps in which every one of its calls failed
    this.lastError = {};
    this.lines = [];   // finished voice entries
    this.pending = []; // voice promises still running
    this.scanned = 0;  // timeline events already looked at for spoken lines
    this.save();
  }

  seatMap() { return Object.fromEntries(Object.entries(this.seats).map(([id, x]) => [id, x.provider])); }

  // time + cost per company and the steps; never who won (the lobby lists games from this file)
  summary() {
    const by = {};
    for (const c of this.app.stats) {
      const b = by[c.provider] || (by[c.provider] = { calls: 0, bad: 0, retried: 0, costUsd: 0, input: 0, output: 0, msTotal: 0, msMax: 0 });
      b.calls++; if (!c.ok) b.bad++; if (c.retried) b.retried++;
      b.costUsd += c.costUsd; b.input += c.input; b.output += c.output; b.msTotal += c.ms; b.msMax = Math.max(b.msMax, c.ms);
    }
    for (const b of Object.values(by)) { b.msAvg = Math.round(b.msTotal / Math.max(1, b.calls)); b.costUsd = +b.costUsd.toFixed(4); }
    return { seed: this.seed, seats: this.seatMap(), asked: this.g.asked, halted: this.halted, voiceMode: this.voiceMode,
      costUsdTotal: +Object.values(by).reduce((s, b) => s + b.costUsd, 0).toFixed(4), byProvider: by, steps: this.steps,
      errors: this.app.stats.filter((c) => !c.ok).map((c) => ({ provider: c.provider, kind: c.kind, error: c.error })) };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.g.timeline, null, 1));
    fs.writeFileSync(this.statsFile, JSON.stringify(this.summary(), null, 1));
  }

  // ---------- voices ----------
  scanLines() {
    const tl = this.g.timeline;
    for (; this.scanned < tl.length; this.scanned++) {
      const e = tl[this.scanned];
      if (VOICED.includes(e.type) && e.id && e.text && String(e.text).trim()) this.addLine(this.scanned, e);
    }
  }

  addLine(idx, e) {
    if (!this.voice) return;
    const L = { e: idx, id: e.id, type: e.type, text: String(e.text).trim() };
    const file = `L${pad(idx, 3)}_${L.id}.mp3`;
    fs.mkdirSync(this.voiceDir, { recursive: true });
    const p = Promise.resolve()
      .then(() => this.voice.say(L.id, L.text, path.join(this.voiceDir, file)))
      .catch((err) => ({ ok: false, error: String(err) }))
      .then((r) => {
        const ok = !!(r && r.ok);
        this.lines.push({ ...L, file: ok ? file : null, dur: ok ? (r.duration_sec || r.audio_sec || 0) : 0 });
        this.writeManifest();
      });
    this.pending.push(p);
  }

  writeManifest() {
    const lines = this.lines.slice().sort((a, b) => a.e - b.e);
    try { fs.writeFileSync(path.join(this.voiceDir, 'manifest.json'), JSON.stringify({ timeline: this.id + '.json', mode: this.voiceMode, lines }, null, 1)); } catch (_) {}
  }

  // ---------- halt ----------
  // after a step: a company whose every call failed (a bad pick is an answer, not a failure) in 2 steps in a row
  // → the error it gives, in Thai
  checkFailures() {
    const fresh = this.app.stats.slice(this.statsSeen);
    this.statsSeen = this.app.stats.length;
    const by = {};
    for (const c of fresh) { const b = by[c.provider] || (by[c.provider] = { n: 0, bad: 0 }); b.n++; if (!c.ok) { b.bad++; this.lastError[c.provider] = c.error; } }
    for (const [prov, b] of Object.entries(by)) {
      if (prov === 'mock') continue;
      this.failStreak[prov] = b.bad === b.n ? (this.failStreak[prov] || 0) + 1 : 0;
      if (this.failStreak[prov] >= 2) {
        const pc = this.app.providers[prov] || {};
        return { provider: prov, message: explainError(prov, this.lastError[prov], pc.model) };
      }
    }
    return null;
  }

  halt(provider, message) {
    this.halted = { provider, message };
    this.g.timeline.push({ n: this.g.asked, type: 'halt', provider, message });
    this.save();
  }

  // takes effect at once: no AI is asked from now on (a call already under way finishes), the loop writes the halt
  abort() {
    if (this.done) return;
    this.aborted = true;
  }

  status() {
    return { id: this.id, running: this.running, done: this.done, halted: this.halted, asked: this.g.asked, questions: this.g.opts.questions, voiceMode: this.voiceMode };
  }

  // one step of the clip's run.js playGame loop → the step's kind
  async step() {
    const g = this.g, app = this.app, seats = this.seats;
    if (g.phase === 'turn') {
      await A.doTurn(g, app, seats);
      if (G.isCheckpoint(g)) {
        this.afterStep('turn');
        if (this.aborted) return 'turn';
        const r = await A.doCheckpoint(g, app, seats);
        if (r && r.kind === 'guess') A.applyCheckpointGuess(g, r);
        else if (r && r.kind === 'accuse') await A.doAccusation(g, app, seats, r);
        return 'checkpoint';
      }
      return 'turn';
    }
    if (g.phase === 'final') { await A.doFinal(g, app, seats); return 'final'; }
    if (g.phase === 'lastGuess') { await A.doGuess(g, app, seats, g.lastGuesser, true); return 'lastGuess'; }
    throw new Error(`stuck in phase ${g.phase}`);
  }

  afterStep(kind, ms = 0) {
    this.steps.push({ kind, n: this.g.asked, ms });
    this.scanLines();
    this.save();
  }

  // never rejects: an error becomes a halt
  async run() {
    if (this.running || this.done) return;
    this.running = true;
    const g = this.g;
    try {
      if (!this.mock) fs.mkdirSync(this.app.sandboxDir, { recursive: true });
      while (g.phase !== 'over') {
        if (this.aborted) { this.halt(null, ABORT_MESSAGE); break; }
        const ts = Date.now();
        const kind = await this.step();
        this.afterStep(kind, Date.now() - ts);
        const stop = this.checkFailures();
        if (stop && g.phase !== 'over') { this.halt(stop.provider, stop.message); break; }
        if (this.mockDelay && g.phase !== 'over') await sleep(this.mockDelay);
      }
    } catch (e) {
      const message = `ผิดพลาด: ${String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 120)}`;
      try { this.halt(null, message); } catch (_) { this.halted = { provider: null, message }; }
    }
    await Promise.all(this.pending);
    this.running = false;
    this.done = true;
  }
}

module.exports = { GameRun, newId, ID_RE, VOICED };
