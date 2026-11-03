// launch.js — what start.bat runs. If the game is already open on this PC, just
// opens the browser on it; otherwise starts the server on the first free port
// (7790 … 7799) and opens the browser. Closing this window closes the game.
//   node app/launch.js            normal start
//   node app/launch.js --selftest plays one test-mode game (no AI calls) to the end, exit 0 = ok
//   VREKI_NO_BROWSER=1            do not open a browser (tests)
'use strict';
const { execFile } = require('child_process');

const APP_ID = 'vreki-spy';
const BASE = Number(process.env.VREKI_PORT) || 7790;
const PORTS = Array.from({ length: 10 }, (_, i) => BASE + i);

// true only for this game (the werewolf or whodunit game may be running on the same PC)
async function probe(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return !!j && j.app === APP_ID;
  } catch (_) { return false; }
}

function openBrowser(url) {
  if (process.env.VREKI_NO_BROWSER) return;
  // explorer hands an http URL to the default browser; no cmd.exe involved
  execFile('explorer.exe', [url], { windowsHide: true }, () => {});
}

// one test-mode game on a free port, then exit (INSTALL-FOR-AI.md runs this).
async function selftest() {
  process.env.VREKI_QUIET = '1';
  const { start, portTaken } = require('./server');
  let s = null;
  for (const port of PORTS) {
    try { s = await start(port); break; } catch (e) { if (!portTaken(e)) throw e; }
  }
  if (!s) { console.log('เช็คไม่ผ่าน: ไม่มี port ว่าง'); return 1; }
  const base = `http://127.0.0.1:${s.port}`;
  try {
    const r = await fetch(`${base}/api/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mock: true, force: true, mockDelay: 10 }) });
    if (!r.ok) { console.log(`เช็คไม่ผ่าน: เริ่มเกมทดสอบไม่ได้ (${r.status})`); return 1; }
    const { id } = await r.json();
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      await new Promise((res) => setTimeout(res, 500));
      const st = await fetch(`${base}/api/status`).then((x) => x.json());
      const g = st.game;
      if (g && g.id === id && g.done) {
        if (g.halted) { console.log(`เช็คไม่ผ่าน: เกมทดสอบหยุดกลางทาง — ${g.halted.message}`); return 1; }
        console.log(`เช็คผ่าน: เกมทดสอบเล่นจนจบ ใน ${Math.round((Date.now() - t0) / 1000)} วินาที`);
        return 0;
      }
    }
    console.log('เช็คไม่ผ่าน: เกมทดสอบไม่จบใน 2 นาที');
    return 1;
  } finally { await s.close(); }
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  for (const port of PORTS) {
    if (await probe(port)) {
      const url = `http://localhost:${port}/`;
      console.log(`เกมเปิดอยู่แล้วที่ ${url} — เปิดหน้าเว็บให้แล้ว`);
      openBrowser(url);
      return 0;
    }
  }
  const { start, portTaken } = require('./server');
  for (const port of PORTS) {
    try {
      const s = await start(port);
      const url = `http://localhost:${s.port}/`;
      console.log('');
      console.log(`  ใครคือสายลับ? เปิดอยู่ที่ ${url}`);
      console.log('  ปิดหน้าต่างนี้ = ปิดเกม');
      console.log('');
      openBrowser(url);
      return null; // keep running
    } catch (e) {
      if (!portTaken(e)) throw e;
    }
  }
  console.log(`เปิดเกมไม่ได้: port ${PORTS[0]}–${PORTS[PORTS.length - 1]} ถูกโปรแกรมอื่นใช้อยู่หมด`);
  return 1;
}

module.exports = { probe, PORTS, APP_ID };

// Exit by letting the event loop drain, never process.exit() straight after fetch(): on Windows
// that can kill the process while libuv is still closing a handle ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING)") and the exit code is lost.
function finish(code) {
  process.exitCode = code;
  // a handle that never closes must not hang the installer; unref'd, so it waits for nothing
  setTimeout(() => process.exit(code), 5000).unref();
}

if (require.main === module) {
  main().then((code) => { if (code != null) finish(code); }, (e) => { console.error(e); finish(1); });
}
