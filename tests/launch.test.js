'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

process.env.VREKI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-launch-'));
process.env.VREKI_QUIET = '1';
const LAUNCH = path.join(__dirname, '..', 'app', 'launch.js');
const { probe, PORTS } = require('../app/launch');
const { start } = require('../app/server');

let srv;
test.before(async () => { srv = await start(0); });
test.after(() => srv.close());

const freePort = () => new Promise((r) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const port = t.address().port; t.close(() => r(port)); }); });
function run(args, env, ms) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [LAUNCH, ...args], { env: { ...process.env, VREKI_NO_BROWSER: '1', ...env } });
    let s = '';
    ch.stdout.on('data', (d) => (s += d));
    ch.stderr.on('data', (d) => (s += d));
    const t = setTimeout(() => { ch.kill(); resolve({ code: 'timeout', s }); }, ms);
    ch.on('exit', (code) => { clearTimeout(t); resolve({ code, s }); });
  });
}

test('the launcher looks on ports 7790 … 7799', () => {
  assert.deepStrictEqual(PORTS, Array.from({ length: 10 }, (_, i) => 7790 + i));
});

test('probe knows this game, and not the werewolf game on the same PC', async () => {
  const ww = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ app: 'vreki-werewolf', version: '1.0.0' })); });
  await new Promise((r) => ww.listen(0, '127.0.0.1', r));
  assert.strictEqual(await probe(ww.address().port), false);
  ww.close();
  assert.strictEqual(await probe(srv.port), true);
  assert.strictEqual(await probe(await freePort()), false); // nothing listening
});

test('a second launch finds the running game instead of starting another server', async () => {
  const out = await run([], { VREKI_PORT: String(srv.port) }, 8000);
  assert.strictEqual(out.code, 0, out.s);
  assert.match(out.s, new RegExp(`localhost:${srv.port}`));
});

test('launch --selftest plays a whole test-mode game and exits 0, naming no winner', async () => {
  const out = await run(['--selftest'], { VREKI_PORT: String(await freePort()), VREKI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wd-self-')) }, 150000);
  assert.strictEqual(out.code, 0, out.s);
  assert.match(out.s, /เช็คผ่าน: เกมทดสอบเล่นจนจบ ใน \d+ วินาที/);
  assert.ok(!/ชนะ|winner/i.test(out.s), out.s);
});
