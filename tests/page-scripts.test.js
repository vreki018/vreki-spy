'use strict';
// every script a page can load must at least parse (a syntax error in one script once hid a whole button)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'app', 'public');
const scripts = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));
const watch = () => fs.readFileSync(path.join(PUB, 'watch.html'), 'utf8');

test('the shared page scripts are there', () => {
  for (const s of ['avatars.js', 'sfx.js']) assert.ok(scripts.includes(s), s);
});

for (const s of scripts) {
  test(`${s} parses`, () => {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(PUB, s), 'utf8')));
  });
}

// each page may only load scripts that exist in public/
for (const page of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
  test(`${page} loads only scripts that exist`, () => {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
      if (/^https?:/.test(src)) continue;
      assert.ok(fs.existsSync(path.join(PUB, src)), `${page} → ${src}`);
    }
  });
}

test('the company logos are there', () => {
  for (const f of ['claude.svg', 'gemini.svg', 'openai_2025.svg']) assert.ok(fs.existsSync(path.join(PUB, 'logos', f)), f);
});

// inline <script> blocks are page code too
for (const page of fs.readdirSync(PUB).filter((f) => f.endsWith('.html'))) {
  test(`${page} inline scripts parse`, () => {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(code), page);
  });
}

test('watch.html: the clip viewer with a way home, live waiting and Thai halt cards', () => {
  const html = watch();
  assert.ok(html.includes('Space หยุด/เล่น · S ดูแบบรู้ว่าใครเป็นสายลับ · T คิดในใจ · U สงสัยใคร'));
  assert.match(html, /<a id="home" class="corner" href="\/">หน้าแรก<\/a>/);
  for (const s of ['รอ AI คิดอยู่…', 'กำลังทำเสียง…', 'เกมหยุดแล้ว', 'เปิดเกมนี้ไม่ได้', 'เกมนี้จบไม่ครบ', 'กลับหน้าแรก']) assert.ok(html.includes(s), s);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Kanit/);
  // the spy, its guesses and the thought cards stay hidden until the reveal unless the viewer asks (S / T keys)
  assert.ok(html.includes("if (qs.get('spy') === '1') stage.classList.add('showspy');"));
  assert.ok(html.includes('#stage:not(.showspy) #spyp { display:none !important; }'));
  assert.ok(html.includes("e.type === 'halt'"), 'a halt event from runner.js ends the page with a card');
  assert.ok(!html.includes('mock_seed3'), 'no clip test file as default');
});

test('stop button: watch page and lobby ask first, then POST /api/abort as JSON', () => {
  const html = watch();
  assert.match(html, /<button id="stopBtn" class="corner" type="button">หยุดเกม<\/button>/);
  assert.ok(html.includes('หยุดเกมนี้เลยไหม?') && html.includes('>ดูต่อ<'));
  assert.ok(html.includes("fetch('/api/abort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })"));
  assert.ok(!/\b(alert|confirm)\(/.test(html), 'no browser dialogs');
  const lobby = fs.readFileSync(path.join(PUB, 'lobby.js'), 'utf8'), index = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(index, /<div id="runningBox"[\s\S]*data-act="stop-running">หยุดเกม<\/button>[\s\S]*?<\/div>/);
  assert.ok(lobby.includes("title: 'หยุดเกมนี้เลยไหม?'") && lobby.includes("post('/api/abort', {})"));
});

// ?t= picks the game file: only the game's own /games/<id>.json may load (a crafted link must not fetch another site)
test('watch.html loads only /games/<id>.json and escapes names and AI text', () => {
  const html = watch();
  const src = html.match(/const T_OK = (\/.+\/);/);
  assert.ok(src, 'T_OK regex');
  const T_OK = new Function('return ' + src[1])();
  for (const ok of ['/games/clip_g1.json', '/games/clip_g5.json', '/games/w_20261103_140501.json', '/games/w_20261103_140501_2.json']) assert.ok(T_OK.test(ok), ok);
  for (const bad of ['https://example.com/x.json', '//example.com/games/x.json', '/games/../app/server.js', '/games/x.json?y', '/games/x.json\n',
    '/games/a/b.json', 'games/x.json', '/games/x.js', '/data/x.json', 'javascript:alert(1)', ' /games/x.json', '/games/%2e%2e.json', '/games/clip_g6.json']) assert.ok(!T_OK.test(bad), bad);
  assert.ok(html.includes("const tlUrl = T_OK.test(qs.get('t') || '') ? qs.get('t') : null;"));
  // bubbles and thoughts by textContent; the spy's guesses, names and places through esc()
  assert.ok(html.includes("b.querySelector('.t').textContent = text || '…';"));
  assert.ok(html.includes("t.querySelector('.t').textContent = text;"));
  assert.ok(html.includes('${esc(r.name)}<div class="bar">'));
  const inner = html.split('\n').filter((l) => l.includes('innerHTML') || l.includes('bigCard(`') || l.includes("`<div class=\"p"));
  for (const l of inner) assert.ok(!/\$\{(r\.name|p\.name|nm\([^)]*\)|PLACE\[[^\]]*\])\}/.test(l), l.trim().slice(0, 120));
  const esc = new Function(html.match(/const esc = .+;/)[0] + ' return esc;')();
  assert.strictEqual(esc('<img src=x onerror="a(1)">&\''), '&lt;img src=x onerror=&quot;a(1)&quot;&gt;&amp;&#39;');
});
