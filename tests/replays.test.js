'use strict';
// The five games recorded for the clip ship in replays/. These checks only ask "is it whole and does it play":
// they never look at who won, who was the spy or where the game took place.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'replays');
const IDS = ['clip_g1', 'clip_g2', 'clip_g3', 'clip_g4', 'clip_g5'];
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'config.default.json'), 'utf8'));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(DIR, ...p), 'utf8'));

test('the replay list names the five clip games in order, with labels that give nothing away', () => {
  const idx = readJson('index.json');
  assert.deepStrictEqual(idx.map((r) => r.id), IDS);
  for (const [i, r] of idx.entries()) assert.strictEqual(r.label, `เกมที่อัดตอนทำคลิป ${i + 1}`);
});

test('replays/ holds only the listed games and their voice folders', () => {
  const allowed = new Set(['index.json', ...IDS.flatMap((id) => [`${id}.json`, `${id}_voice`])]);
  for (const f of fs.readdirSync(DIR)) assert.ok(allowed.has(f), f);
});

for (const id of IDS) {
  test(`${id}: whole game with the clip rules and the six players`, () => {
    const tl = readJson(`${id}.json`);
    assert.ok(Array.isArray(tl) && tl.length > 10);
    const deal = tl[0];
    assert.strictEqual(deal.type, 'deal');
    assert.deepStrictEqual(deal.players.map((p) => p.id).sort(), [...CONFIG.game.cast].sort());
    const { questions, checkEvery, passRatio, trialAt, lastGuess } = deal.opts;
    assert.deepStrictEqual({ questions, checkEvery, passRatio, trialAt, lastGuess }, { questions: 12, checkEvery: 4, passRatio: 0.75, trialAt: 3, lastGuess: true });
    // 2·2·2 over the three companies
    const seats = {};
    for (const p of deal.players) seats[p.seat] = (seats[p.seat] || 0) + 1;
    assert.deepStrictEqual(seats, { claude: 2, codex: 2, gemini: 2 });
    assert.strictEqual(tl.filter((e) => e.type === 'over').length, 1, 'ends once');
    assert.strictEqual(tl.at(-1).type, 'over');
    assert.ok(!tl.some((e) => e.type === 'halt'));
    // games recorded before the vote fix stored a running count here (that whole set was dropped, 2026-11-03)
    assert.ok(tl.filter((e) => e.type === 'vote').every((e) => typeof e.yes === 'boolean'), 'a vote stores the voter\'s own yes');
    // one model per company all game (a Gemini seat that fell back to another model is not the clip's game)
    assert.ok(!tl.some((e) => e.type === 'warn' && e.what === 'mixed'), 'mixed models');
  });

  test(`${id}: every voice file the manifest names is there, and nothing else is`, (t) => {
    const vdir = path.join(DIR, `${id}_voice`);
    if (!fs.existsSync(vdir)) return t.skip('no voices for this game');
    const man = readJson(`${id}_voice`, 'manifest.json');
    assert.strictEqual(man.timeline, `${id}.json`);
    const tl = readJson(`${id}.json`);
    const named = new Set(['manifest.json']);
    for (const l of man.lines) {
      assert.ok(tl[l.e] && tl[l.e].id === l.id, `line ${l.e} is not ${l.id}'s`);
      if (l.file == null) continue;
      assert.match(l.file, /^L\d{3}_[a-z]+\.mp3$/);
      assert.ok(fs.statSync(path.join(vdir, l.file)).size > 1000, `empty ${l.file}`);
      named.add(l.file);
    }
    for (const f of fs.readdirSync(vdir)) assert.ok(named.has(f), `stray ${f}`);
  });
}

test('no path, key or machine name inside a replay', () => {
  for (const id of IDS) {
    const raw = fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8');
    assert.doesNotMatch(raw, /[A-Za-z]:[\\/]|\\\\|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/, id);
  }
});
