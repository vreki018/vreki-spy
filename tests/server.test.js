'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spy-srv-'));
process.env.VREKI_DATA_DIR = tmp;
process.env.VREKI_QUIET = '1';
const P = require('../app/paths');
const { start, portTaken } = require('../app/server');

let base, srv;
test.before(async () => { srv = await start(0); base = `http://127.0.0.1:${srv.port}`; });
test.after(() => srv.close());

const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
// raw path, so ".." and "%2e" reach the server as typed (fetch would tidy them first)
function raw(p) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, method: 'GET', path: p, headers: { Host: `127.0.0.1:${srv.port}` } }, (res) => {
      const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }));
    });
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await get('/api/status');
    if (s.body.game && s.body.game.id === id && s.body.game.done) return s.body.game;
    await sleep(100);
  }
  throw new Error('game did not finish');
}

test('a port reserved by Windows (EACCES) counts as taken, so the launcher tries the next one', () => {
  assert.strictEqual(portTaken({ code: 'EADDRINUSE' }), true);
  assert.strictEqual(portTaken({ code: 'EACCES' }), true);
  assert.strictEqual(portTaken({ code: 'ENOMEM' }), false);
});

test('status names the app and has no game yet', async () => {
  const r = await get('/api/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.app, 'vreki-spy');
  assert.ok(r.body.version);
  assert.strictEqual(r.body.game, null);
});

test('setup lists the place-card choice and has no mic', async () => {
  const r = await get('/api/setup');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.places, ['show', 'hide']);
  assert.ok(!('mic' in r.body));
  for (const k of ['claude', 'codex', 'gemini', 'python', 'ffmpeg']) assert.strictEqual(typeof r.body.detect[k].ready, 'boolean', k);
  if (!r.body.detect.ffmpeg.ready) assert.match(r.body.detect.ffmpeg.reason, /ffmpeg/);
  assert.strictEqual(r.body.voiceModes.off, true);
});

test('setup sends each company a model list for the dropdown that holds its default model', async () => {
  const r = await get('/api/setup');
  for (const id of ['claude', 'codex', 'gemini']) {
    const list = r.body.labels[id].models;
    assert.ok(Array.isArray(list) && list.length >= 2, id);
    assert.ok(list.some((m) => m.id === r.body.defaults.models[id]), `${id} default in its list`);
    for (const m of list) {
      assert.match(m.id, /^[A-Za-z0-9][\w.\-:]*$/, `${id} ${m.id}`); // what /api/settings accepts
      assert.ok(m.label && typeof m.label === 'string', `${id} ${m.id} label`);
    }
    assert.strictEqual(new Set(list.map((m) => m.id)).size, list.length, `${id} no repeats`);
  }
});

test('the Gemini key is saved to its file and never sent back', async () => {
  const KEY = 'test-key-' + 'abc123';
  const s = await post('/api/settings', { geminiKey: KEY, voice: 'gemini' });
  assert.strictEqual(s.body.geminiKeySet, true);
  assert.strictEqual(fs.readFileSync(P.GEMINI_KEY_FILE, 'utf8').trim(), KEY);
  const setup = await fetch(base + '/api/setup?refresh=1').then((r) => r.text());
  assert.ok(!setup.includes(KEY));
  assert.ok(!fs.readFileSync(P.SETTINGS_FILE, 'utf8').includes(KEY));
  const del = await post('/api/settings', { geminiKey: null });
  assert.strictEqual(del.body.geminiKeySet, false);
  assert.ok(!fs.existsSync(P.GEMINI_KEY_FILE));
});

test('a real game with no company picked is refused in Thai', async () => {
  await post('/api/settings', { providers: [] });
  const r = await post('/api/new', { providers: [] });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /เลือก/);
});

test('an unknown connection test is refused in Thai', async () => {
  const r = await post('/api/test', { provider: 'nobody' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

test('a mock game plays to the end and its timeline is served', async () => {
  const r = await post('/api/new', { mock: true, mockDelay: 0 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.match(r.body.id, /^w_[0-9_]+$/);
  assert.strictEqual(r.body.place, 'show');
  assert.strictEqual(r.body.voiceUsed, 'off'); // mock games are silent unless mockVoice
  assert.strictEqual(r.body.watch, `/watch.html?t=/games/${r.body.id}.json&live=1&voice=0`);
  const st = await waitDone(r.body.id);
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.running, false);
  const tl = await raw(`/games/${r.body.id}.json`);
  assert.strictEqual(tl.status, 200);
  assert.match(tl.type, /application\/json/);
  const arr = JSON.parse(tl.body.toString('utf8'));
  assert.ok(Array.isArray(arr) && arr.length > 0);
});

test('a hidden place card goes into the watch link, seats split between companies', async () => {
  const r = await post('/api/new', { mock: true, mockDelay: 0, place: 'hide', providers: ['claude', 'codex'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.place, 'hide');
  assert.strictEqual(r.body.watch, `/watch.html?t=/games/${r.body.id}.json&live=1&voice=0&place=0`);
  assert.deepStrictEqual(r.body.seats, { claude: 3, codex: 3 });
  await waitDone(r.body.id);
});

test('starting while a game runs is refused with 409 unless forced', async () => {
  const a = await post('/api/new', { mock: true, mockDelay: 300 });
  assert.strictEqual(a.status, 200);
  const b = await post('/api/new', { mock: true, mockDelay: 0 });
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.body.error, 'มีเกมกำลังเล่นอยู่');
  const c = await post('/api/new', { mock: true, mockDelay: 0, force: true });
  assert.strictEqual(c.status, 200);
  assert.notStrictEqual(c.body.id, a.body.id);
  const s = await get('/api/status');
  assert.strictEqual(s.body.game.id, c.body.id); // status follows the new game at once
  await waitDone(c.body.id);
});

test('abort stops the running game', async () => {
  // aborted during the wait after the first question (which can never end the game) → stops before the second one
  const a = await post('/api/new', { mock: true, mockDelay: 300 });
  assert.strictEqual(a.status, 200);
  const ab = await post('/api/abort', {});
  assert.strictEqual(ab.body.ok, true);
  const st = await waitDone(a.body.id);
  assert.strictEqual(st.halted && st.halted.message, 'หยุดเกมแล้ว');
});

test('two quick starts at once begin one game, the other gets 409', async () => {
  await post('/api/settings', { geminiKey: null }); // clears the program check cache: the first start waits on a fresh check, as on a real PC
  const [a, b] = await Promise.all([post('/api/new', { mock: true, mockDelay: 50 }), post('/api/new', { mock: true, mockDelay: 50 })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const ok = a.status === 200 ? a : b, no = a.status === 200 ? b : a;
  assert.match(no.body.error, /มีเกม/);
  const s = await get('/api/status');
  assert.strictEqual(s.body.game.id, ok.body.id);
  await post('/api/abort', {});
  await waitDone(ok.body.id);
});

// checked on the pure functions: a game with voices on would call edge-tts over the network
test('Gemini voice without a key (or ffmpeg) falls back to the free voice, then to none', () => {
  const { voiceModes, pickVoice } = require('../app/server');
  const det = (py, tts, key, ff) => ({ python: { ready: py, edgeTts: tts }, gemini: { ready: key }, ffmpeg: { ready: ff } });
  assert.strictEqual(pickVoice('gemini', voiceModes(det(true, true, true, true))), 'gemini');
  assert.strictEqual(pickVoice('gemini', voiceModes(det(true, true, false, true))), 'free');
  assert.strictEqual(pickVoice('gemini', voiceModes(det(true, true, true, false))), 'free');
  assert.strictEqual(pickVoice('gemini', voiceModes(det(true, false, true, true))), 'off');
  assert.strictEqual(pickVoice('free', voiceModes(det(false, false, true, true))), 'off');
  assert.strictEqual(pickVoice('off', voiceModes(det(true, true, true, true))), 'off');
});

test('the game list starts with the five clip games, and no row names a winner', async () => {
  const r = await get('/api/games');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.slice(0, 5).map((g) => g.id), ['clip_g1', 'clip_g2', 'clip_g3', 'clip_g4', 'clip_g5']);
  for (const g of r.body.slice(0, 5)) { assert.strictEqual(g.fromClip, true); assert.ok(g.label); }
  const own = r.body.slice(5);
  assert.ok(own.length >= 3);
  for (const g of r.body) assert.ok(!('winner' in g), g.id);
  for (const g of own) {
    assert.match(g.id, /^w_[0-9_]+$/);
    assert.ok(!g.fromClip);
    assert.strictEqual(g.mock, true);
    assert.strictEqual(typeof g.durationSec, 'number');
  }
  const ids = own.map((g) => g.id);
  assert.deepStrictEqual(ids, [...ids].sort().reverse()); // newest first
});

test('clip games are served, with their voice files when they have voices', async () => {
  for (const id of ['clip_g1', 'clip_g2', 'clip_g3', 'clip_g4', 'clip_g5']) {
    const tl = await raw(`/games/${id}.json`);
    assert.strictEqual(tl.status, 200);
    assert.ok(Array.isArray(JSON.parse(tl.body.toString('utf8'))));
    if (!fs.existsSync(path.join(P.REPLAYS, `${id}_voice`, 'manifest.json'))) continue;
    const m = await raw(`/games/${id}_voice/manifest.json`);
    assert.strictEqual(m.status, 200);
    const man = JSON.parse(m.body.toString('utf8'));
    assert.strictEqual(man.timeline, `${id}.json`);
    const file = man.lines.find((l) => l.file).file;
    const mp3 = await raw(`/games/${id}_voice/${file}`);
    assert.strictEqual(mp3.status, 200);
    assert.strictEqual(mp3.type, 'audio/mpeg');
    assert.ok(mp3.body.length > 1000);
    assert.strictEqual((await raw(`/games/${id}_voice/${file}.json`)).status, 404); // sidecars are not shipped or served
  }
});

test('path tricks on the file routes give 404', async () => {
  for (const p of [
    '/games/..%2fapp%2fserver.js', '/games/clip_g1_voice/../../x', '/games/../app/server.js', '/games/%2e%2e/app/server.js',
    '/games/clip_g1_voice/..%2f..%2fpackage.json', '/games/clip_g1_voice/%2e%2e/clip_g1.json', '/games/clip_g6.json', '/games/rec_g1.json',
    '/games/w_1.stats.json', '/games/clip_g1_voice/notes.txt', '/games/server.log', '/../package.json', '/%2e%2e/package.json',
  ]) {
    const r = await raw(p);
    assert.strictEqual(r.status, 404, p);
  }
});

test('/api/status after a game shows its status, never a winner', async () => {
  const s = await get('/api/status');
  assert.ok(s.body.game);
  for (const k of ['id', 'running', 'done', 'halted', 'asked', 'questions', 'voiceMode']) assert.ok(k in s.body.game, k);
  assert.ok(!('winner' in s.body.game));
});
