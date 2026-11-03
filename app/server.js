// server.js — serves the lobby and watch pages, runs one game of "ใครคือสายลับ?" at a time
// (runner.js, in this process) and hands out the game files: the timeline <id>.json and the
// spoken-line voices <id>_voice/ that the runner rewrites while the game is played.
// The watch page polls those files; there is no event stream.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GameRun, ID_RE } = require('./runner');
const { Voice } = require('./voice');
const P = require('./paths');
const S = require('./settings');
const D = require('./detect');

const APP_ID = 'vreki-spy';
const VERSION = require('../package.json').version;
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
CONFIG.sandboxDir = P.SANDBOX;
const PUB = path.join(__dirname, 'public');
P.ensureDataDirs();
const SERVER_LOG = path.join(P.LOGS, 'server.log');
const QUIET = !!process.env.VREKI_QUIET;
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(SERVER_LOG, line); } catch (_) {}
  if (!QUIET) process.stdout.write(line);
}

let game = null;  // the current GameRun (an aborted one may still be finishing its own files)
let voice = null; // tts.py workers, started by the first game that has voices on
let starting = false; // a /api/new is between its first await and `game = …`: a second one must not start a second game

// which voice modes this PC can play right now
function voiceModes(det) {
  const py = !!(det.python.ready && det.python.edgeTts);
  return { off: true, free: py, gemini: !!(py && det.gemini.ready && det.ffmpeg.ready) };
}
// the asked-for mode, or the next one down that works (gemini → free → off)
function pickVoice(want, modes) {
  const order = ['gemini', 'free', 'off'];
  for (const m of order.slice(Math.max(0, order.indexOf(want)))) if (modes[m]) return m;
  return 'off';
}
function voiceFor(mode, det) {
  if (mode === 'off') return null;
  if (!voice) {
    voice = new Voice({ ...CONFIG.voice, python: det.python.path, script: path.join(__dirname, 'tts.py'),
      env: { VREKI_GEMINI_KEY_FILE: P.GEMINI_KEY_FILE, VREKI_TTS_USAGE_LOG: P.TTS_USAGE_LOG, ...(det.ffmpeg.path ? { VREKI_FFMPEG: det.ffmpeg.path } : {}) } }, log);
  }
  const over = mode === 'free' ? { engine: 'edge' } : {};
  return { say: (char, text, out) => voice.say(char, text, out, over) };
}

const NO_FFMPEG = 'ยังไม่มี ffmpeg — เสียง Gemini ต้องใช้ ffmpeg (ให้ AI ติดตั้งตาม INSTALL-FOR-AI.md)';

function setupInfo(det, settings) {
  const pub = (d) => ({ ready: !!d.ready, reason: d.reason || null, warn: d.warn || null });
  const ffmpeg = pub(det.ffmpeg);
  if (!ffmpeg.ready && !ffmpeg.reason) ffmpeg.reason = NO_FFMPEG;
  return {
    settings,
    detect: { claude: pub(det.claude), codex: pub(det.codex), gemini: pub(det.gemini), python: { ...pub(det.python), edgeTts: !!det.python.edgeTts }, ffmpeg },
    voiceModes: voiceModes(det),
    places: [...S.PLACE_MODES],
    defaults: S.DEFAULTS,
    labels: Object.fromEntries(S.COMPANIES.map((id) => [id, { label: CONFIG.providers[id].label, color: CONFIG.providers[id].color, modelLabel: CONFIG.providers[id].modelLabel, models: CONFIG.providers[id].models || [] }])),
  };
}

const THAI_COMPANY = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); }
function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { const v = b ? JSON.parse(b) : {}; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch (_) { resolve({}); } });
  });
}

const MIME = { '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// the games recorded for the clip ship in replays/ (read-only); the viewer's own games live in data/logs
let clipIndex = [];
try { clipIndex = JSON.parse(fs.readFileSync(path.join(P.REPLAYS, 'index.json'), 'utf8')); } catch (_) {}
const OWN_ID = /^w_[0-9_]+$/;
const VOICE_FILE = /^(manifest\.json|L\d{3}_[a-z]+\.mp3)$/;

// first existing file among LOGS/<name>, REPLAYS/<name> (name already checked against the patterns above)
function gameFile(...parts) {
  for (const root of [P.LOGS, P.REPLAYS]) {
    const f = path.join(root, ...parts);
    try { if (fs.statSync(f).isFile()) return f; } catch (_) {}
  }
  return null;
}

// all-mock / play time of an own game, from its stats file — never who won
function ownRow(id) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(P.LOGS, id + '.stats.json'), 'utf8')); } catch (_) {}
  const seats = s && s.seats ? Object.values(s.seats) : [];
  const steps = s && Array.isArray(s.steps) ? s.steps : [];
  return {
    id,
    mock: seats.length > 0 && seats.every((x) => x === 'mock'),
    durationSec: s ? Math.round(steps.reduce((n, x) => n + (+x.ms || 0), 0) / 1000) : null,
  };
}

function listGames() {
  const clip = clipIndex.filter((c) => ID_RE.test(c.id) && !OWN_ID.test(c.id) && fs.existsSync(path.join(P.REPLAYS, c.id + '.json')))
    .map((c) => ({ id: c.id, label: c.label, fromClip: true }));
  let own = [];
  try {
    own = fs.readdirSync(P.LOGS).map((f) => f.match(/^(w_[0-9_]+)\.json$/)).filter(Boolean).map((m) => m[1])
      .sort().reverse().map(ownRow);
  } catch (_) {}
  return [...clip, ...own];
}

// Only the game's own page may talk to the game. Other sites open in the same browser
// could otherwise POST here (a text/plain "simple request" skips CORS) or read it through
// DNS rebinding: refuse foreign Host / Origin, and POSTs that are not JSON.
function blocked(req) {
  const port = server.address()?.port;
  const own = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!own.includes(String(req.headers.host || '').toLowerCase())) return [403, 'forbidden host'];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !own.some((h) => origin.toLowerCase() === `http://${h}`)) return [403, 'forbidden origin'];
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) return [415, 'json only'];
  }
  return null;
}

// POST /api/new (one at a time: see `starting`)
async function newGame(req, res) {
  const b = await body(req);
  if (game && !game.done) {
    if (!b.force) return json(res, 409, { error: 'มีเกมกำลังเล่นอยู่' });
    game.abort(); // asks no AI from now on; an answer already under way finishes, then it writes its halt (own files only)
    log('abort game', game.id, '(new game forced)');
  }
  const settings = S.loadSettings();
  const det = await D.detectAll(settings);
  const mock = !!b.mock;
  let providers = Array.isArray(b.providers) ? [...new Set(b.providers.filter((x) => S.COMPANIES.includes(x)))] : settings.providers;
  if (mock && !providers.length) providers = [...S.COMPANIES]; // test mode needs no AI at all
  if (!providers.length) return json(res, 400, { error: 'เลือกค่าย AI อย่างน้อย 1 ค่ายก่อนเริ่มเกม' });
  if (!mock) {
    const notReady = providers.filter((x) => !det[x].ready);
    if (notReady.length) return json(res, 400, { error: `${notReady.map((x) => THAI_COMPANY[x]).join(' · ')} ยังไม่พร้อม — ${det[notReady[0]].reason || 'เช็คในหน้าตั้งค่า'}` });
  }
  const seats = S.seatSplit(providers);
  const place = S.PLACE_MODES.includes(b.place) ? b.place : settings.place;
  const wantVoice = S.VOICES.includes(b.voice) ? b.voice : settings.voice;
  const voiceUsed = mock && !b.mockVoice ? 'off' : pickVoice(wantVoice, voiceModes(det));
  const mockDelay = Math.min(10000, Math.max(0, Number(b.mockDelay) || 0));
  const cfg = D.withTools(S.applyModels(CONFIG, settings), det);
  const g = new GameRun(cfg, { providers: mock ? null : seats, mock, mockDelay, voice: voiceFor(voiceUsed, det), voiceMode: voiceUsed, outDir: P.LOGS });
  game = g;
  log('new game', g.id, 'mock', mock, 'place', place, 'seats', JSON.stringify(seats), 'voice', voiceUsed);
  setImmediate(() => g.run().then(() => log('game done', g.id, g.halted ? `halted: ${g.halted.message}` : 'ended')));
  return json(res, 200, { ok: true, id: g.id, seats, voiceUsed, place, watch: `/watch.html?t=/games/${g.id}.json&live=1&voice=${voiceUsed === 'off' ? 0 : 1}${place === 'hide' ? '&place=0' : ''}` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const no = blocked(req);
  if (no) return json(res, no[0], { error: no[1] });
  try {
    if (p === '/api/setup') {
      const settings = S.loadSettings();
      const det = await D.detectAll(settings, { refresh: url.searchParams.get('refresh') === '1' });
      return json(res, 200, setupInfo(det, settings));
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      delete b.paths; // program paths are never set over HTTP (the game runs them); edit data/settings.json by hand
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim() && !/^[\x21-\x7e]+$/.test(b.geminiKey.trim())) {
        return json(res, 400, { error: 'คีย์ Gemini ต้องเป็นตัวอักษรภาษาอังกฤษ/ตัวเลขติดกัน ไม่มีช่องว่างหรือขึ้นบรรทัดใหม่' });
      }
      if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) {
        fs.mkdirSync(P.DATA, { recursive: true });
        fs.writeFileSync(P.GEMINI_KEY_FILE, b.geminiKey.trim());
      } else if (b.geminiKey === null) {
        try { fs.unlinkSync(P.GEMINI_KEY_FILE); } catch (_) {}
      }
      if ('geminiKey' in b) D.clearDetectCache();
      delete b.geminiKey;
      const settings = S.saveSettings(b);
      const geminiKeySet = fs.existsSync(P.GEMINI_KEY_FILE);
      return json(res, 200, { settings, geminiKeySet });
    }

    if (p === '/api/test' && req.method === 'POST') {
      const b = await body(req);
      if (!S.COMPANIES.includes(b.provider)) return json(res, 400, { ok: false, ms: 0, message: 'ไม่รู้จักค่ายนี้' });
      const settings = S.loadSettings();
      const det = await D.detectAll(settings);
      const r = await D.testProvider(b.provider, S.applyModels(CONFIG, settings), det);
      log('test', b.provider, r.ok ? 'ok' : 'FAIL', r.ms, r.raw || '');
      return json(res, 200, { ok: r.ok, ms: r.ms, message: r.message });
    }

    if (p === '/api/new' && req.method === 'POST') {
      // taken before the first await: two quick clicks (or two tabs) start one game, the other gets 409
      if (starting) return json(res, 409, { error: 'มีเกมกำลังเริ่มอยู่ · รอสักครู่' });
      starting = true;
      try { return await newGame(req, res); } finally { starting = false; }
    }

    if (p === '/api/abort' && req.method === 'POST') {
      if (game && !game.done) { game.abort(); log('abort game', game.id); }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/status') return json(res, 200, { app: APP_ID, version: VERSION, game: game ? game.status() : null });

    if (p === '/api/games') return json(res, 200, listGames());

    if (p === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      log('shutdown requested');
      if (game && !game.done) game.abort();
      setTimeout(() => { voice && voice.close(); process.exit(0); }, 400);
      return;
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // a path with dot-segments or encoded dots/slashes is never a real file request: the URL parser
    // would fold "/games/x_voice/%2e%2e/y" into another route, so refuse it before that
    const rawPath = String(req.url || '').split('?')[0];
    if (/\.\.|%2e|%2f|%5c|\\/i.test(rawPath)) return notFound(res);

    // game files: the runner rewrites them (truncate + write) while a game is played, so the
    // JSON ones are read in one synchronous call, which cannot interleave with a rewrite
    if (p.startsWith('/games/')) {
      const tm = p.match(/^\/games\/([A-Za-z0-9_]+)\.json$/);
      const vm = p.match(/^\/games\/([A-Za-z0-9_]+)_voice\/([A-Za-z0-9_.]+)$/);
      let f = null;
      if (tm && ID_RE.test(tm[1])) f = gameFile(tm[1] + '.json');
      else if (vm && ID_RE.test(vm[1]) && VOICE_FILE.test(vm[2])) f = gameFile(vm[1] + '_voice', vm[2]);
      if (!f) return notFound(res);
      if (f.endsWith('.json')) {
        const buf = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
    }

    // static
    let f = p === '/' ? '/index.html' : p;
    f = path.normalize(path.join(PUB, f));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return notFound(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    log('error', e.stack || e);
    try { json(res, 500, { error: String(e) }); } catch (_) {}
  }
});

// → Promise<{ port, close() }>; rejects with EADDRINUSE when the port is taken (launch.js tries the next one)
function start(port = CONFIG.port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => {
      server.off('error', onErr);
      server.on('error', (e) => log('server error', e.stack || e));
      const real = server.address().port;
      log(`spy game on http://localhost:${real} pid ${process.pid}`);
      // close() → Promise that settles once the server has really stopped (launch --selftest waits on it)
      resolve({ port: real, close: () => new Promise((done) => { if (game && !game.done) game.abort(); voice && voice.close(); voice = null; server.close(() => done()); server.closeAllConnections?.(); }) });
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// in use by another program, or reserved by Windows (Hyper-V / WSL port ranges give EACCES)
const portTaken = (e) => !!e && (e.code === 'EADDRINUSE' || e.code === 'EACCES');

module.exports = { start, portTaken, voiceModes, pickVoice, APP_ID };

if (require.main === module) {
  const argPort = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7));
  start(argPort || Number(process.env.VREKI_PORT) || CONFIG.port).catch((e) => { log('cannot start:', e.code || e); process.exit(1); });
}
