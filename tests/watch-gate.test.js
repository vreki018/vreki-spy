'use strict';
// A browser lets a page make sound only after a click, so a game that starts by itself loses its first lines.
// These run the watch page's real script on a stand-in page (timers cut to nothing) and watch which voices it plays.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'watch.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

const GAME = [
  { type: 'deal', place: 'p', placeName: 'ที่ทดสอบ', spies: [], places: [], opts: { questions: 12 },
    players: [{ id: 'fah', name: 'ฟ้า', seat: 'claude' }, { id: 'wit', name: 'วิทย์', seat: 'codex' }] },
  { type: 'ask', id: 'fah', to: 'wit', text: 'ประโยคแรก', q: 'ประโยคแรก' },
];
const FIRST_VOICE = '/games/clip_g1_voice/L001_fah.mp3';

// anything on the page: each property or call gives another stand-in, values set on it read back
function standIn(on) {
  const saved = {};
  return new Proxy(function () {}, {
    get(_, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return () => [][Symbol.iterator]();
      if (k === 'then') return undefined;
      if (k === 'addEventListener') return (type, fn) => { if (on) on[type] = fn; };
      if (k in saved) return saved[k];
      return (saved[k] = standIn());
    },
    set(_, k, v) { saved[k] = v; return true; },
    apply: () => standIn(),
  });
}

function openPage(t) {
  const listeners = {}, elements = {}, played = [];
  let open = true;
  t.after(() => { open = false; }); // a paused page keeps polling: end it with the test
  const el = (sel) => (elements[sel] ??= standIn((listeners[sel] = {})));
  class FakeAudio { constructor(src) { played.push(src); } play() { return Promise.resolve(); } pause() {} }
  const page = {
    location: { search: '?t=/games/clip_g1.json' },
    document: { querySelector: el, querySelectorAll: () => [], createElement: () => standIn(), fonts: { ready: Promise.resolve() },
      addEventListener: (type, fn) => { (listeners.document ??= {})[type] = fn; } },
    fetch: async (url) => ({ ok: true, json: async () => (url.endsWith('manifest.json')
      ? { lines: [{ e: 1, id: 'fah', type: 'ask', file: 'L001_fah.mp3', dur: 1 }] } : GAME) }),
    Audio: FakeAudio,
    SFX: { player: () => standIn() },
    avatarSVG: () => '', faceSVG: () => '',
    setTimeout: (fn) => { if (open) setImmediate(fn); },
    requestAnimationFrame: () => {}, addEventListener: () => {}, innerWidth: 1920, innerHeight: 1080,
    performance, URLSearchParams, console,
  };
  page.window = page;
  const ctx = vm.createContext(page);
  vm.runInContext(script, ctx);
  return { played, listeners, state: () => JSON.parse(vm.runInContext('JSON.stringify({ phase: S.phase, i: S.i })', ctx)) };
}
const settle = async () => { for (let k = 0; k < 300; k++) await new Promise(setImmediate); };

test('watch page: left alone, the game waits at the first line and plays nothing', async (t) => {
  const p = openPage(t);
  await settle();
  assert.deepStrictEqual(p.state(), { phase: 'play', i: 0 });
  assert.deepStrictEqual(p.played, []);
});

test('watch page: the click starts the game and the first line is heard', async (t) => {
  const p = openPage(t);
  await settle();
  p.listeners['#snd'].click();
  await settle();
  assert.deepStrictEqual(p.played, [FIRST_VOICE]);
});

test('watch page: pressing Space before the click does not leave the game stuck after it', async (t) => {
  const p = openPage(t);
  await settle();
  p.listeners.document.keydown({ key: ' ', preventDefault() {} });
  p.listeners['#snd'].click();
  await settle();
  assert.deepStrictEqual(p.played, [FIRST_VOICE]);
});
