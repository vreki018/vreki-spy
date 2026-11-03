// setup.js — the lobby's "ตั้งค่า AI และเสียง" card: which companies play, their models and
// effort, the per-company connection test, the Gemini key and the voice mode.
// Every change is saved to the server (data/settings.json); lobby.js reads SETUP.current()
// when a game starts. Also the centred question card (SETUP.ask) — never the browser's confirm().
'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IDS = ['claude', 'codex', 'gemini'];
  const NAME = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };
  const LOGO = { claude: 'logos/claude.svg', codex: 'logos/openai_2025.svg', gemini: 'logos/gemini.svg' };
  const HOW = { claude: 'ผ่าน Claude Code (แพ็ก Claude)', codex: 'ผ่าน Codex (บัญชี ChatGPT)', gemini: 'ผ่านคีย์ API ของ Gemini' };
  const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
  const VOICE_TH = { off: 'ปิดเสียง', free: 'เสียงฟรี', gemini: 'เสียง Gemini' };

  let info = null;      // last /api/setup answer
  let settings = null;  // what is saved
  const tests = {};     // id → { ok, message } from the last "ทดสอบ"
  const typing = {};    // id → true once the viewer picked "อื่นๆ" (types the model name)
  const CUSTOM = '__custom';
  let saveTimer = null;
  let pending = {};
  let loadedOnce;
  const loaded = new Promise((r) => { loadedOnce = r; });

  function save(patch, now = false) {
    const models = patch.models ? { ...(pending.models || {}), ...patch.models } : pending.models;
    const effort = patch.effort ? { ...(pending.effort || {}), ...patch.effort } : pending.effort;
    Object.assign(pending, patch);
    if (models) pending.models = models;
    if (effort) pending.effort = effort;
    clearTimeout(saveTimer);
    const go = async () => {
      const body = pending; pending = {};
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
      if (r?.settings) settings = r.settings;
      renderStrip();
      return r;
    };
    if (now) return go();
    saveTimer = setTimeout(go, 400);
    return null;
  }

  async function load(refresh) {
    info = await fetch('/api/setup' + (refresh ? '?refresh=1' : '')).then((r) => r.json()).catch(() => null);
    if (!info) { $('#stripSeats').textContent = 'ติดต่อเกมไม่ได้ — ลองเปิด start.bat ใหม่'; loadedOnce(null); return; }
    settings = info.settings;
    // first visit: tick every company that is ready
    if (!settings.providers.length) {
      const ready = IDS.filter((id) => info.detect[id].ready);
      if (ready.length) { settings.providers = ready; await save({ providers: ready }, true); }
    }
    renderStrip();
    if (!$('#setup').hidden) renderCard();
    loadedOnce(settings);
  }

  function picked() { return (settings?.providers || []).filter((id) => info?.detect[id]?.ready); }

  // same split as the server: 6 · 3+3 · 2+2+2
  function split(ids) {
    const out = {};
    ids.forEach((id, i) => { out[id] = Math.floor(6 / ids.length) + (i < 6 % ids.length ? 1 : 0); });
    return out;
  }
  function seatText(ids) {
    if (!ids.length) return 'ยังไม่ได้เลือกค่าย AI';
    return 'ที่นั่ง: ' + Object.entries(split(ids)).map(([id, n]) => `${NAME[id]} ${n}`).join(' · ');
  }
  function voiceNow() {
    const want = settings?.voice || 'free';
    const order = ['gemini', 'free', 'off'];
    for (const m of order.slice(Math.max(0, order.indexOf(want)))) if (info?.voiceModes?.[m]) return m;
    return 'off';
  }

  function renderStrip() {
    if (!info || !settings) return;
    const ids = picked();
    $('#stripSeats').textContent = seatText(ids);
    $('#stripSeats').classList.toggle('warn', !ids.length);
    const v = voiceNow();
    $('#stripVoice').textContent = `เสียง: ${VOICE_TH[v]}${v !== settings.voice ? ` (เลือก${VOICE_TH[settings.voice]}ไว้ แต่ยังใช้ไม่ได้)` : ''}`;
  }

  function chip(id) {
    const d = info.detect[id];
    const t = tests[id];
    if (!d.ready) return `<span class="chip bad">${id === 'gemini' ? 'ยังไม่มีคีย์' : /ล็อกอิน/.test(d.reason || '') ? 'ยังไม่ล็อกอิน' : 'ยังไม่ได้ติดตั้ง'}</span>`;
    if (t) return `<span class="chip ${t.ok ? 'good' : 'bad'}">${t.ok ? 'ใช้ได้' : 'มีปัญหา'}</span>`;
    return '<span class="chip">พร้อม</span>';
  }

  // the model dropdown (the server's list) + "อื่นๆ" for a model the list does not have yet
  function modelPick(id) {
    const list = info.labels?.[id]?.models || [];
    const cur = settings.models[id];
    const listed = !typing[id] && list.some((m) => m.id === cur);
    const opts = list.map((m) => `<option value="${esc(m.id)}" ${listed && m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    const pick = `<label class="model">รุ่น <select data-model-pick="${id}">${opts}<option value="${CUSTOM}" ${listed ? '' : 'selected'}>อื่นๆ (พิมพ์ชื่อรุ่นเอง)</option></select></label>`;
    const type = listed ? '' : `
        <label class="model custom-model">ชื่อรุ่น <input type="text" data-model="${id}" value="${esc(cur)}" placeholder="พิมพ์ชื่อรุ่นให้ตรงตัว เช่น ${esc(list[0]?.id || '')}" spellcheck="false"></label>`;
    return { pick, type };
  }

  function renderCard() {
    const rows = IDS.map((id) => {
      const model = modelPick(id);
      const d = info.detect[id];
      const on = settings.providers.includes(id) && d.ready;
      const t = tests[id];
      const msg = t ? t.message : (d.ready ? (d.warn || '') : (id === 'gemini' ? 'ยังไม่มีคีย์ — วางคีย์ Gemini ด้านล่างแล้วกดบันทึก (ไม่บังคับ)' : d.reason || ''));
      const effort = id in (settings.effort || {}) ? `
        <label class="model effort">ระดับคิด <select data-effort="${id}">${EFFORTS.map((e) => `<option value="${e}" ${settings.effort[id] === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>` : '<span></span>';
      const key = id === 'gemini' ? `
        <div class="key-row">
          <input type="password" id="geminiKey" placeholder="${d.ready ? 'มีคีย์แล้ว · วางคีย์ใหม่เพื่อเปลี่ยน' : 'วางคีย์ Gemini (aistudio.google.com)'}" autocomplete="off" spellcheck="false">
          <button class="btn" data-act="save-key">บันทึกคีย์</button>
          ${d.ready ? '<button class="link" data-act="del-key">ลบคีย์</button>' : ''}
        </div>` : '';
      return `
      <div class="prov-row ${d.ready ? '' : 'off'}" data-id="${id}">
        <label class="check prov-pick"><input type="checkbox" data-pick="${id}" ${on ? 'checked' : ''} ${d.ready ? '' : 'disabled'}>
          <span class="brand"><img src="${LOGO[id]}" alt=""></span>
          <span class="prov-name"><b>${NAME[id]}</b><small>${HOW[id]}</small></span></label>
        ${chip(id)}
        ${model.pick}
        ${effort}
        <button class="btn" data-test="${id}" ${d.ready ? '' : 'disabled'}>ทดสอบ</button>${model.type}
        <p class="prov-msg ${t && !t.ok ? 'bad' : ''}">${esc(msg)}</p>
        ${key}
      </div>`;
    }).join('');
    $('#provRows').innerHTML = rows;
    $('#seatLine').textContent = seatText(picked());
    const used = voiceNow(); // the mode a game would really get
    for (const r of document.querySelectorAll('input[name="voice"]')) {
      r.checked = r.value === used;
      r.disabled = !info.voiceModes[r.value];
    }
    const notes = [];
    if (!info.voiceModes.free) notes.push(info.detect.python.reason || 'เสียงฟรีต้องใช้ Python + edge-tts');
    if (!info.voiceModes.gemini) notes.push(!info.detect.gemini.ready ? 'เสียง Gemini ต้องใส่คีย์ Gemini ก่อน' : (!info.detect.ffmpeg.ready ? (info.detect.ffmpeg.reason || 'เสียง Gemini ต้องติดตั้ง ffmpeg') : ''));
    notes.push('เสียง Gemini มีปัญหาบรรทัดไหน จะใช้เสียงฟรีแทนบรรทัดนั้น');
    $('#voiceNote').textContent = notes.filter(Boolean).join(' · ');
  }

  function openSetup() { if (!info) return; $('#setup').hidden = false; renderCard(); }
  function closeSetup() { $('#setup').hidden = true; renderStrip(); }

  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    const act = a?.dataset.act;
    if (act === 'open-setup') openSetup();
    if (act === 'close-setup') { await save({}, true); closeSetup(); }
    if (act === 'recheck') { a.disabled = true; await load(true); a.disabled = false; }
    if (act === 'save-key') {
      const k = $('#geminiKey').value.trim();
      if (!k) return;
      const r = await save({ geminiKey: k }, true);
      delete tests.gemini;
      await load(true);
      if (r?.error) { tests.gemini = { ok: false, message: r.error }; renderCard(); }
    }
    if (act === 'del-key') {
      if (!(await SETUP.confirm('ลบคีย์ Gemini ออกจากเครื่องนี้?'))) return;
      await save({ geminiKey: null }, true);
      delete tests.gemini;
      await load(true);
    }
    const t = e.target.closest('[data-test]');
    if (t) {
      const id = t.dataset.test;
      t.disabled = true; t.textContent = 'กำลังทดสอบ…';
      await save({}, true);
      const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: id }) }).then((x) => x.json()).catch(() => ({ ok: false, message: 'ติดต่อเกมไม่ได้' }));
      tests[id] = r;
      renderCard();
    }
  });

  document.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const ids = IDS.filter((id) => document.querySelector(`[data-pick="${id}"]`)?.checked);
      settings.providers = ids;
      $('#seatLine').textContent = seatText(picked());
      save({ providers: ids });
    }
    const mp = e.target.closest('[data-model-pick]');
    if (mp) {
      const id = mp.dataset.modelPick;
      delete tests[id];
      typing[id] = mp.value === CUSTOM;
      if (!typing[id]) { settings.models[id] = mp.value; save({ models: { [id]: mp.value } }); }
      renderCard();
      if (typing[id]) document.querySelector(`[data-model="${id}"]`)?.focus();
    }
    const m = e.target.closest('[data-model]');
    if (m && m.value.trim()) { delete tests[m.dataset.model]; settings.models[m.dataset.model] = m.value.trim(); save({ models: { [m.dataset.model]: m.value.trim() } }); }
    const ef = e.target.closest('[data-effort]');
    if (ef) { settings.effort[ef.dataset.effort] = ef.value; save({ effort: { [ef.dataset.effort]: ef.value } }); }
    if (e.target.name === 'voice') { settings.voice = e.target.value; save({ voice: e.target.value }); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#setup').hidden && $('#askBox').hidden) closeSetup();
    if (e.key === 'Enter' && e.target.id === 'geminiKey') document.querySelector('[data-act="save-key"]')?.click();
  });

  // centred card on a dimmed page: ask({ title, text, buttons: [{ id, label, primary }] }) → the id clicked
  // (Escape = 'cancel'). Never the browser's alert() / confirm().
  function ask({ title = '', text = '', buttons }) {
    return new Promise((resolve) => {
      const box = $('#askBox');
      $('#askTitle').textContent = title;
      $('#askTitle').hidden = !title;
      $('#askText').textContent = text;
      $('#askText').hidden = !text;
      $('#askButtons').innerHTML = buttons.map((b) => `<button class="btn ${b.primary ? 'primary' : ''}" data-ask="${esc(b.id)}">${esc(b.label)}</button>`).join('');
      box.hidden = false;
      const done = (id) => { box.hidden = true; box.onclick = null; document.removeEventListener('keydown', onKey, true); resolve(id); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); } };
      document.addEventListener('keydown', onKey, true);
      box.onclick = (e) => { const b = e.target.closest('[data-ask]'); if (b) done(b.dataset.ask); };
      box.querySelector('[data-ask="cancel"], [data-ask="no"]')?.focus(); // Enter never picks the harmful choice
    });
  }

  window.SETUP = {
    // what the next game uses
    current() { return { providers: picked(), voice: settings?.voice || 'free' }; },
    ready() { return picked().length > 0; },
    loaded,                       // → settings once /api/setup answered (null if the game is unreachable)
    settings: () => settings,
    save,
    open: openSetup,
    ask,
    async confirm(text) {
      return (await ask({ text, buttons: [{ id: 'no', label: 'ยกเลิก' }, { id: 'yes', label: 'ตกลง', primary: true }] })) === 'yes';
    },
  };

  load(false);
})();
