'use strict';
// The runner plays the clip's game loop inside the server. These checks never look at who won or who was the spy:
// "over" is the pass.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spy-run-'));
process.env.VREKI_DATA_DIR = tmp;
const { GameRun, ID_RE, VOICED } = require('../app/runner');
const { callProvider } = require('../app/providers');
const S = require('../app/settings');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.default.json'), 'utf8'));
const newDir = () => fs.mkdtempSync(path.join(tmp, 'out-'));
const readTl = (r) => JSON.parse(fs.readFileSync(r.file, 'utf8'));
// a stand-in for a real company: a legal answer for every kind, no AI call
const fakeAnswer = (prov, cfg, app, req) => callProvider('mock', {}, { mockDelay: 0 }, req);

test('test-mode games play to the end with the clip rules', async () => {
  for (let seed = 1; seed <= 8; seed++) {
    const outDir = newDir();
    const r = new GameRun(CONFIG, { mock: true, seed, voice: null, voiceMode: 'off', outDir });
    assert.match(r.id, ID_RE);
    await r.run();
    const tl = readTl(r);
    const deal = tl[0];
    assert.strictEqual(deal.type, 'deal');
    assert.deepStrictEqual(deal.players.map((p) => p.id), CONFIG.game.cast);
    assert.ok(deal.players.every((p) => p.seat === 'mock'));
    assert.strictEqual(deal.opts.questions, 12);
    assert.strictEqual(deal.opts.checkEvery, 4);
    assert.strictEqual(deal.opts.trialAt, 3);
    assert.strictEqual(deal.spies.length, 1);
    assert.strictEqual(tl[tl.length - 1].type, 'over', `seed ${seed}`);
    assert.ok(tl.filter((e) => e.type === 'ask').length <= 12);
    const st = r.status();
    assert.deepStrictEqual([st.done, st.running, st.halted], [true, false, null]);
    assert.ok(fs.existsSync(r.statsFile));
  }
});

test('the stats file holds time, seats and steps, never the outcome', async () => {
  const r = new GameRun(CONFIG, { mock: true, seed: 3, outDir: newDir() });
  await r.run();
  const s = JSON.parse(fs.readFileSync(r.statsFile, 'utf8'));
  assert.ok(Array.isArray(s.steps) && s.steps.length > 0);
  assert.ok(Object.values(s.seats).every((x) => x === 'mock'));
  for (const k of ['winner', 'how', 'spies', 'place', 'points', 'campScore']) assert.ok(!(k in s), k);
});

for (const picked of [['claude'], ['claude', 'gemini'], ['claude', 'codex', 'gemini']]) {
  test(`${picked.length} compan${picked.length > 1 ? 'ies' : 'y'} share the six seats evenly`, async () => {
    const seats = S.seatSplit(picked);
    const r = new GameRun(CONFIG, { providers: seats, seed: 5, outDir: newDir(), callOverride: fakeAnswer });
    const count = {};
    for (const s of Object.values(r.seats)) count[s.provider] = (count[s.provider] || 0) + 1;
    assert.deepStrictEqual(count, seats);
    assert.strictEqual(Object.values(seats).reduce((a, b) => a + b, 0), 6);
    await r.run();
    assert.strictEqual(readTl(r).at(-1).type, 'over');
    assert.ok(r.app.stats.length > 0 && r.app.stats.every((c) => c.ok));
  });
}

test('a company whose every call fails stops the game with a Thai message', async () => {
  const fail = (prov, cfg, app, req) => (prov === 'codex' ? Promise.resolve({ ok: false, ms: 1, error: 'usage limit reached' }) : fakeAnswer(prov, cfg, app, req));
  const r = new GameRun(CONFIG, { providers: { claude: 3, codex: 3 }, seed: 2, outDir: newDir(), callOverride: fail });
  await r.run();
  const tl = readTl(r);
  const h = tl.at(-1);
  assert.strictEqual(h.type, 'halt');
  assert.strictEqual(h.provider, 'codex');
  assert.match(h.message, /[ก-๙]/);
  assert.deepStrictEqual(r.status().halted, { provider: 'codex', message: h.message });
});

test('abort stops the game at its next step with "หยุดเกมแล้ว"', async () => {
  let n = 0;
  const slow = (prov, cfg, app, req) => { n++; return new Promise((res) => setTimeout(res, 20)).then(() => fakeAnswer(prov, cfg, app, req)); };
  const r = new GameRun(CONFIG, { providers: { claude: 6 }, seed: 4, outDir: newDir(), callOverride: slow });
  const p = r.run();
  await new Promise((res) => setTimeout(res, 60));
  r.abort();
  await p;
  const tl = readTl(r);
  assert.deepStrictEqual([tl.at(-1).type, tl.at(-1).message], ['halt', 'หยุดเกมแล้ว']);
  const before = n;
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(n, before, 'no AI is asked after the game stopped');
});

test('every spoken line gets a voice file named by its timeline index', async () => {
  const said = [];
  const voice = { say: async (char, text, out) => { said.push(out); fs.writeFileSync(out, 'x'); return { ok: true, duration_sec: 1.5 }; } };
  const r = new GameRun(CONFIG, { mock: true, seed: 6, voice, voiceMode: 'free', outDir: newDir() });
  await r.run();
  const tl = readTl(r);
  const man = JSON.parse(fs.readFileSync(path.join(r.voiceDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(man.timeline, r.id + '.json');
  assert.strictEqual(man.mode, 'free');
  const spoken = tl.map((e, i) => [e, i]).filter(([e]) => VOICED.includes(e.type) && e.text && String(e.text).trim()).map(([, i]) => i);
  assert.deepStrictEqual(man.lines.map((l) => l.e), spoken);
  for (const l of man.lines) {
    assert.strictEqual(l.id, tl[l.e].id);
    assert.match(l.file, /^L\d{3}_[a-z]+\.mp3$/);
    assert.ok(fs.existsSync(path.join(r.voiceDir, l.file)));
    assert.strictEqual(l.dur, 1.5);
  }
  assert.strictEqual(said.length, spoken.length);
});

test('a failed voice line is listed with no file, the game still ends', async () => {
  const voice = { say: async () => ({ ok: false, error: 'tts down' }) };
  const r = new GameRun(CONFIG, { mock: true, seed: 7, voice, voiceMode: 'gemini', outDir: newDir() });
  await r.run();
  const man = JSON.parse(fs.readFileSync(path.join(r.voiceDir, 'manifest.json'), 'utf8'));
  assert.ok(man.lines.length > 0 && man.lines.every((l) => l.file === null));
  assert.strictEqual(readTl(r).at(-1).type, 'over');
});

test('only own and clip game ids are accepted', () => {
  for (const ok of ['w_20261103_101500', 'w_20261103_101500_2', 'clip_g1', 'clip_g5']) assert.match(ok, ID_RE);
  for (const bad of ['clip_g6', '../x', 'rec_g1', 'w_x']) assert.doesNotMatch(bad, ID_RE);
  assert.throws(() => new GameRun(CONFIG, { mock: true, id: '../x', outDir: newDir() }));
});
