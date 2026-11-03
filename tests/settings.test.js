'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spy-set-'));
process.env.VREKI_DATA_DIR = tmp;
const P = require('../app/paths');
const { seatSplit, loadSettings, saveSettings, applyModels, DEFAULTS, PLACE_MODES } = require('../app/settings');

test('seatSplit: one company takes all 6 seats', () => {
  assert.deepStrictEqual(seatSplit(['claude']), { claude: 6 });
  for (const id of ['codex', 'gemini']) assert.deepStrictEqual(seatSplit([id]), { [id]: 6 });
});

test('seatSplit: any two companies split 3 + 3', () => {
  assert.deepStrictEqual(seatSplit(['claude', 'gemini']), { claude: 3, gemini: 3 });
  for (const pair of [['claude', 'codex'], ['codex', 'gemini']]) {
    const s = seatSplit(pair);
    assert.strictEqual(s[pair[0]], 3);
    assert.strictEqual(s[pair[1]], 3);
    assert.strictEqual(Object.keys(s).length, 2);
  }
});

test('seatSplit: all three companies split 2 + 2 + 2, order does not matter', () => {
  assert.deepStrictEqual(seatSplit(['gemini', 'claude', 'codex']), { gemini: 2, claude: 2, codex: 2 });
});

test('seatSplit: duplicates count once', () => {
  assert.deepStrictEqual(seatSplit(['claude', 'claude']), { claude: 6 });
});

test('seatSplit: empty or unknown company throws', () => {
  assert.throws(() => seatSplit([]));
  assert.throws(() => seatSplit(['agy']));
});

test('place card: show (default) or hide', () => {
  assert.deepStrictEqual(PLACE_MODES, ['show', 'hide']);
  assert.strictEqual(DEFAULTS.place, 'show');
});

test('no mic / show-companies settings (not part of this game)', () => {
  assert.ok(!('mic' in DEFAULTS));
  assert.ok(!('showCompanies' in DEFAULTS));
  assert.ok(!('sttPython' in DEFAULTS.paths));
  assert.deepStrictEqual(Object.keys(DEFAULTS.paths).sort(), ['claude', 'codex', 'ffmpeg', 'python']);
});

test('settings round-trip and never store the Gemini key', () => {
  const s = saveSettings({ providers: ['claude', 'gemini'], voice: 'gemini', place: 'hide', models: { codex: 'gpt-6.1-luna' }, geminiKey: 'should-not-be-saved' });
  assert.deepStrictEqual(s.providers, ['claude', 'gemini']);
  assert.strictEqual(s.models.codex, 'gpt-6.1-luna');
  assert.strictEqual(s.models.claude, DEFAULTS.models.claude);
  assert.strictEqual(s.place, 'hide');
  const again = loadSettings();
  assert.deepStrictEqual(again, s);
  assert.ok(!fs.readFileSync(P.SETTINGS_FILE, 'utf8').includes('should-not-be-saved'));
});

test('a saved rule set is kept until it is changed', () => {
  saveSettings({ place: 'hide' });
  assert.strictEqual(saveSettings({ voice: 'off' }).place, 'hide');
  assert.strictEqual(saveSettings({ place: 'show' }).place, 'show');
});

test('invalid values fall back to defaults', () => {
  fs.writeFileSync(P.SETTINGS_FILE, JSON.stringify({ providers: ['agy', 'codex'], voice: 'loud', place: 'x', mic: true, showCompanies: true, effort: { claude: 'ultra' } }));
  const s = loadSettings();
  assert.deepStrictEqual(s.providers, ['codex']);
  assert.strictEqual(s.voice, DEFAULTS.voice);
  assert.strictEqual(s.place, 'show');
  assert.strictEqual(s.effort.claude, DEFAULTS.effort.claude);
  assert.ok(!('mic' in s) && !('showCompanies' in s), 'unknown keys are dropped');
});

test('place hide in the file is kept', () => {
  fs.writeFileSync(P.SETTINGS_FILE, JSON.stringify({ place: 'hide' }));
  assert.strictEqual(loadSettings().place, 'hide');
});

test('a model name that starts with "-" is refused (it would be read as a CLI flag)', () => {
  const s = saveSettings({ models: { claude: '--dangerously-skip-permissions' } });
  assert.strictEqual(s.models.claude, DEFAULTS.models.claude);
});

test('a corrupt settings file gives the defaults', () => {
  fs.writeFileSync(P.SETTINGS_FILE, '{not json');
  assert.deepStrictEqual(loadSettings(), DEFAULTS);
});

test('applyModels copies models and effort into the provider config', () => {
  const cfg = { providers: { claude: { model: 'claude-opus-5-5', modelLabel: 'Opus 5.5' }, codex: { model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' }, gemini: { model: 'gemini-4-argon', modelLabel: '4 Argon' } } };
  const out = applyModels(cfg, { ...DEFAULTS, models: { ...DEFAULTS.models, gemini: 'gemini-3.8-flash' }, effort: { claude: 'high', codex: 'low' } });
  assert.strictEqual(out.providers.gemini.model, 'gemini-3.8-flash');
  assert.strictEqual(out.providers.gemini.modelLabel, 'gemini-3.8-flash');
  assert.strictEqual(out.providers.claude.modelLabel, 'Opus 5.5');
  assert.strictEqual(out.providers.claude.effort, 'high');
  assert.strictEqual(out.providers.codex.effort, 'low');
  assert.strictEqual(cfg.providers.gemini.model, 'gemini-4-argon', 'input config is not changed');
});

test('applyModels names a model picked from the dropdown by its list label', () => {
  const cfg = { providers: { claude: { model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] } } };
  const listed = applyModels(cfg, { ...DEFAULTS, models: { ...DEFAULTS.models, claude: 'claude-sonnet-5-5' } });
  assert.strictEqual(listed.providers.claude.modelLabel, 'Sonnet 5.5');
  const typed = applyModels(cfg, { ...DEFAULTS, models: { ...DEFAULTS.models, claude: 'claude-opus-9-9' } });
  assert.strictEqual(typed.providers.claude.modelLabel, 'claude-opus-9-9', 'a typed model keeps its own name');
});

test('config.default.json is portable: no machine paths, no backup provider, game limits set', () => {
  const raw = fs.readFileSync(path.join(P.APP, 'config.default.json'), 'utf8');
  const cfg = JSON.parse(raw);
  assert.strictEqual(cfg.port, 7790);
  // the clip's rules, number for number
  assert.deepStrictEqual({ ...cfg.game }, { cast: ['fah', 'wit', 'muay', 'tee', 'win', 'khem'], spies: 1, questions: 12, checkEvery: 4, passRatio: 0.75, lastGuess: true, trialAt: 3 });
  assert.deepStrictEqual(cfg.characters.map((c) => c.id), cfg.game.cast);
  for (const k of ['sandboxDir', 'logsDir', 'stt']) assert.ok(!(k in cfg), k);
  assert.ok(!('agy' in cfg.providers));
  for (const [id, pc] of Object.entries(cfg.providers)) {
    for (const k of ['exe', 'script', 'desktopDir', 'keyFile', 'fallback', 'modelLive', 'modelLiveLabel', 'liveNote']) assert.ok(!(k in pc), `${id}.${k}`);
  }
  assert.ok(!('python' in cfg.voice) && !('script' in cfg.voice));
  assert.strictEqual(cfg.characters.length, 6);
  assert.doesNotMatch(raw, /[A-Z]:[\\/]|\\\\/, 'no drive or UNC paths');
  // the defaults the lobby shows are the config models
  for (const id of ['claude', 'codex', 'gemini']) assert.strictEqual(cfg.providers[id].model, DEFAULTS.models[id]);
});
