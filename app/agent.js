'use strict';
// agent.js — turns the spy game (game.js) into AI calls (providers.js) and back into moves.
// Every seat gets the same system line, rules and history; only the persona and the own card differ (spec §4).
// Choices are numbered menus (as in the earlier games), so a model can only pick something legal; a bad pick is logged by the engine.
// Own asides are never fed back into prompts: Opus 5.5 safeguards read that as reasoning extraction (found 2026-10-18).
const G = require('./game.js');

let caller = require('./providers').callProvider;
const setCaller = (fn) => { caller = fn; };

const SYSTEM = 'คุณกำลังเล่นเกมปาร์ตี้หาสายลับ "ใครคือสายลับ?" กับผู้เล่นคนอื่นที่เป็น AI · เล่นตามนิสัยตัวละคร พูดภาษาไทยแบบคนจริง · ตอบเป็น JSON อย่างเดียว';
const FILLER = 'ขอคิดแป๊บนึงนะ';
// smoke game 2026-11-02: lines ran to 3–4 sentences (~60 words) → ask for a word budget too
const SPEECH = 'พูดสั้นๆ 1–2 ประโยค ไม่เกินราว 30 คำ แบบคนคุยกันจริง ห้ามพูดเลขข้อ ห้ามนับว่าถามกันไปกี่ครั้งแล้ว';

const nm = (g, id) => (g.players.find((p) => p.id === id) || { name: id }).name;
const placeName = (g, id) => (g.places.find((p) => p.id === id) || { name: id }).name;

function rulesText(g, id) {
  const n = g.players.length, voters = n - 2, need = Math.ceil(g.opts.passRatio * voters);
  const spies = g.opts.spies > 1 || g.spies.length > 1 ? `${g.spies.length} คน (สายลับไม่รู้ว่าอีกคนคือใคร)` : '1 คน';
  const card = G.isSpy(g, id) ? 'การ์ดของคุณ: คุณคือสายลับ ไม่รู้ว่าที่นี่คือที่ไหน' : `การ์ดของคุณ: สถานที่: ${g.place.name} · บทบาทของคุณ: ${g.roles[id]}`;
  return [
    'กติกา:',
    `- ผู้เล่น ${n} คนนั่งล้อมวง ทุกคนได้การ์ดสถานที่เดียวกันพร้อมบทบาทของตัวเอง ยกเว้นสายลับ ${spies} ที่ไม่รู้ว่าที่นี่คือที่ไหน`,
    '- ผลัดกันถามเป็นทอด: คนที่โดนถามต้องตอบ แล้วถามคนต่อไป ห้ามถามกลับคนที่เพิ่งถามตัวเอง',
    // trial_4 2026-11-02: the town never heard the spy enough to accuse → everyone gets the same number of turns
    '- ถามได้เฉพาะคนที่ได้ตอบน้อยที่สุดในตอนนั้น ทุกคนจึงได้ตอบพอๆ กัน รวมทั้งสายลับ',
    // trial_1 2026-11-02: town answers named waiting rooms / being sick → the spy guessed the place at the first checkpoint
    '- คนทั่วไป: ตอบให้พวกเดียวกันรู้ว่าคุณรู้จักที่นี่จริง แต่ต้องกว้างพอที่จะเป็นได้หลายที่ในรายชื่อ ห้ามพูดชื่อสถานที่ ห้ามพูดของหรืองานที่มีแค่ที่นี่ เพราะสายลับฟังอยู่ทุกคำและจะเดาได้ทันที (ถามคำถามก็เหมือนกัน อย่าถามจนคำตอบเฉลยสถานที่)',
    '- สายลับ: ฟังคำถามคำตอบแล้วเดาว่าที่นี่คือที่ไหน ตอบให้เนียนเหมือนรู้ ห้ามบอกว่าตัวเองเป็นสายลับ',
    // trial_1–8 2026-11-02: nobody ever accused alone → VreKi picked option A: everyone points, trialAt+ = automatic trial
    `- เป็นระยะมีช่วงตัดสินใจ: ทุกคนชี้พร้อมกันว่าสงสัยใครที่สุด (ต้องชี้ 1 คน) · ใครโดนชี้ตั้งแต่ ${g.opts.trialAt} คนขึ้นไป ต้องแก้ตัว แล้วคนที่เหลือโหวต ถ้าเห็นด้วยอย่างน้อย ${need} จาก ${voters} คน คนนั้นต้องเปิดการ์ด · ทุกคนเห็นว่าใครชี้ใคร`,
    // trial_1 + trial_2 2026-11-02: nobody ever accused, the spy guessed right both times → state the cost of waiting (same text for all)
    // trial_1–4 2026-11-02: the spy guessed right every game before anyone accused → the spy may guess only at the last checkpoint
    '- สายลับเปิดตัวแล้วเดาสถานที่ได้เฉพาะช่วงตัดสินใจครั้งสุดท้าย (ช่วงก่อนหน้าเดาไม่ได้): เดาถูก = สายลับชนะ · เดาผิด = สายลับแพ้ · ยิ่งปล่อยไว้นาน สายลับยิ่งได้ยินคำตอบมากและยิ่งเดาง่าย',
    // trial_11/12 2026-11-02: nobody voted yes for fear a wrong catch ends the game → VreKi: a wrong catch only clears that person
    // trial_13 2026-11-02: caught at 4 questions, the spy still guessed right → VreKi: caught mid-game = the spy loses
    '- สายลับโดนจับในช่วงตัดสินใจ = สายลับแพ้ทันที · ช่วงตัดสินใจจับผิดคน = คนนั้นเปิดการ์ดว่าบริสุทธิ์แล้วเล่นต่อ (เกมไม่จบ)',
    '- คำถามหมดแล้ว ทุกคนโหวตพร้อมกันว่าใครคือสายลับ · คะแนนสูงสุดเท่ากัน = ไม่มีใครโดน = สายลับชนะ · โหวตรอบนี้โดนคนบริสุทธิ์ = สายลับชนะ · สายลับโดนจับในโหวตรอบนี้ยังเดาสถานที่ได้อีก 1 ครั้ง ถ้าถูกก็ยังชนะ',
    // trial_5 + trial_6 2026-11-02: 0 accusations again — the final vote costs nothing and nobody was told a catch pays more
    '- แต้มของแต่ละคน: ฝ่ายคนทั่วไปชนะ ได้คนละ 1 แต้ม · ทุกคนที่ชี้คนที่โดนเปิดการ์ดแล้วเป็นสายลับ ได้ 2 แต้มแทน (จับได้ในโหวตรอบสุดท้ายไม่มีโบนัส) · สายลับชนะได้ 4 แต้ม (รอดเพราะโหวตเสมอได้ 2)',
    `สถานที่ที่เป็นไปได้: ${g.places.map((p) => p.name).join(' · ')}`,
    `ผู้เล่น: ${g.players.map((p) => p.name).join(' · ')}`,
    card,
  ].join('\n');
}

const header = (g, id, persona) => `คุณคือ "${nm(g, id)}" · นิสัย: ${persona}`;

// public record only: questions, answers, accusations, defences, vote results (no asides, no numbers)
function historyText(g) {
  const out = [];
  let votes = [];
  for (const e of g.timeline) {
    if (e.type === 'ask') out.push(`${nm(g, e.id)} ถาม ${nm(g, e.to)}: "${e.text}"`);
    else if (e.type === 'answer') out.push(`${nm(g, e.id)} ตอบ: "${e.text}"`);
    else if (e.type === 'checkpoint') {
      const p = Object.entries(e.decisions).filter(([, d]) => d.act === 'point' && d.target).map(([id, d]) => `${nm(g, id)} → ${nm(g, d.target)}`);
      if (p.length) out.push(`ช่วงตัดสินใจ ทุกคนชี้คนที่สงสัย: ${p.join(' · ')}`);
    } else if (e.type === 'accuse') { out.push(`${nm(g, e.target)} โดนชี้มากที่สุด ต้องแก้ตัว · ${nm(g, e.id)} พูดแทนคนที่ชี้: "${e.text}"`); votes = []; }
    else if (e.type === 'defend') out.push(`${nm(g, e.id)} แก้ตัว: "${e.text}"`);
    else if (e.type === 'reveal' && !e.isSpy && e.via === 'accuse') out.push(`${nm(g, e.id)} เปิดการ์ด: ไม่ใช่สายลับ → พ้นข้อสงสัย เล่นต่อ`);
    else if (e.type === 'vote') votes.push(e);
    else if (e.type === 'voteResult') {
      const yes = votes.filter((v) => v.yes).map((v) => nm(g, v.id)), no = votes.filter((v) => !v.yes).map((v) => nm(g, v.id));
      out.push(`ผลโหวต: ${e.pass ? 'ผ่าน' : 'ไม่ผ่าน'} · เห็นด้วย: ${yes.join(', ') || 'ไม่มี'} · ไม่เห็นด้วย: ${no.join(', ') || 'ไม่มี'}${e.pass ? '' : ' → เล่นต่อ'}`);
    }
  }
  return out.length ? out.join('\n') : '(ยังไม่มีใครถาม)';
}

const menu = (lines) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
const base = (g, id, persona) => [header(g, id, persona), '', rulesText(g, id), '', 'บทสนทนาที่ผ่านมา:', historyText(g), ''];

function turnPrompt(g, id, persona) {
  const t = G.turnInfo(g);
  const spy = G.isSpy(g, id);
  const lines = base(g, id, persona);
  lines.push(t.question ? `ตาคุณ: ${nm(g, t.question.from)} ถามคุณว่า "${t.question.q}" → ตอบคำถามนี้` : 'ตาคุณ: คุณเป็นคนเริ่มถามคนแรก (ไม่มีอะไรต้องตอบ ใส่ answer เป็น "")');
  if (t.last) lines.push('นี่คือคำตอบสุดท้ายก่อนโหวต ไม่ต้องถามต่อ (ใส่ target กับ question เป็น "")');
  else lines.push('แล้วเลือกคนที่จะถามต่อ:', menu(t.canAsk.map((x) => nm(g, x))));
  lines.push(SPEECH, '');
  lines.push(`ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","answer":"คำตอบที่พูดออกไป","target":"เลขข้อของคนที่จะถาม","question":"คำถามที่พูดออกไป","suspect":"ชื่อคนที่คุณสงสัยที่สุดตอนนี้ หรือ ยังไม่รู้",` +
    (spy ? '"guesses":"3 สถานที่ที่คุณเดาว่าน่าจะเป็น พร้อมความมั่นใจ เช่น ชื่อที่ก:50,ชื่อที่ข:30,ชื่อที่ค:20"}' : '"guesses":""}'));
  return { prompt: lines.join('\n'), kind: 'turn', options: t.canAsk, info: t };
}

function optionLabel(g, o) {
  if (o.act === 'point') return `ชี้ ${nm(g, o.target)}`;
  return `เปิดตัวว่าเป็นสายลับ แล้วเดาว่าที่นี่คือ ${placeName(g, o.place)}`;
}

function checkPrompt(g, id, persona) {
  const options = G.checkOptions(g, id);
  const lines = base(g, id, persona);
  // trial_6 2026-11-02: the spy at 95% waited at the last checkpoint — nothing told it this was the last chance
  if (g.asked >= g.opts.guessFrom) lines.push('ตอนนี้คือช่วงตัดสินใจครั้งสุดท้าย หลังจากนี้ถามกันจนหมดแล้วโหวตรอบสุดท้าย');
  lines.push(G.isSpy(g, id) && options.some((o) => o.act === 'guess') ? 'ถึงช่วงตัดสินใจ: ชี้คนที่สงสัย 1 คน หรือเปิดตัวแล้วเดาสถานที่ (ทุกคนเลือกพร้อมกัน)' : 'ถึงช่วงตัดสินใจ: ชี้คนที่คุณสงสัยว่าเป็นสายลับที่สุด 1 คน (ทุกคนชี้พร้อมกัน แล้วทุกคนเห็นว่าใครชี้ใคร)', menu(options.map((o) => optionLabel(g, o))), SPEECH, '');
  lines.push('ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","target":"เลขข้อที่เลือก","confidence":"มั่นใจกี่เปอร์เซ็นต์ 0-100 ว่าคนที่คุณสงสัยที่สุดคือสายลับ (สายลับ: มั่นใจกี่เปอร์เซ็นต์ว่าเดาสถานที่ถูก)","say":"เหตุผลที่พูดออกไปกับทุกคน ถ้าคนที่คุณชี้ต้องขึ้นแก้ตัว (สายลับที่เดา: คำพูดตอนเปิดตัว)"}');
  return { prompt: lines.join('\n'), kind: 'check', options };
}

function defendPrompt(g, id, persona) {
  const lines = base(g, id, persona);
  lines.push(`${(g.acc.pointers || [g.acc.by]).map((x) => nm(g, x)).join(', ')} ชี้ว่าคุณเป็นสายลับ (${nm(g, g.acc.by)} พูดแทน) → แก้ตัวกับทุกคน`, SPEECH, '', 'ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","say":"คำแก้ตัวที่พูดออกไป"}');
  return { prompt: lines.join('\n'), kind: 'last', options: [] };
}

function votePrompt(g, id, persona) {
  const lines = base(g, id, persona);
  lines.push(`โหวต: ${nm(g, g.acc.target)} คือสายลับไหม (เปิดการ์ดเมื่อเห็นด้วยพอ)`, menu(['เห็นด้วย ให้เปิดการ์ด', 'ไม่เห็นด้วย เล่นต่อ']), SPEECH, '');
  lines.push('ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","target":"เลขข้อที่เลือก","say":"เหตุผลสั้นๆ 1 ประโยคที่พูดออกไป"}');
  return { prompt: lines.join('\n'), kind: 'vote', options: [true, false] };
}

function finalPrompt(g, id, persona) {
  const options = g.players.map((p) => p.id).filter((x) => x !== id && !(g.cleared || []).includes(x));
  const lines = base(g, id, persona);
  lines.push('คำถามหมดแล้ว ทุกคนโหวตพร้อมกันว่าใครคือสายลับ:', menu(options.map((x) => nm(g, x))), SPEECH, '');
  lines.push('ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","target":"เลขข้อของคนที่โหวต","say":"เหตุผลสั้นๆ 1 ประโยคที่พูดออกไป"}');
  return { prompt: lines.join('\n'), kind: 'vote', options };
}

function guessPrompt(g, id, persona, last) {
  const options = g.places.map((p) => p.id);
  const lines = base(g, id, persona);
  lines.push(last ? 'คุณโดนจับได้แล้วว่าเป็นสายลับ แต่ยังเดาสถานที่ได้ 1 ครั้ง ถ้าเดาถูกคุณยังชนะ:' : 'เลือกสถานที่ที่คุณเดา:', menu(options.map((x) => placeName(g, x))), SPEECH, '');
  lines.push('ตอบ JSON: {"aside":"คิดในใจสั้นๆ 1 ประโยค","target":"เลขข้อของสถานที่","say":"สิ่งที่พูดออกไปตอนเดา"}');
  return { prompt: lines.join('\n'), kind: 'vote', options };
}

// "3" / "ข้อ 3" → index 2 ; anything else → -1
const pickNum = (v, n) => { const m = String(v == null ? '' : v).match(/\d+/); const k = m ? +m[0] : 0; return k >= 1 && k <= n ? k - 1 : -1; };
// at most 2 sentences (split on . ! ? … or a double space) and 240 characters, cut at a space
function clip(text) {
  let s = String(text || '').replace(/\s+\n/g, ' ').trim();
  const parts = s.split(/(?<=[.!?…])\s+|\s{2,}/).filter(Boolean);
  if (parts.length > 2) s = parts.slice(0, 2).join(' ');
  if (s.length > 240) { const cut = s.lastIndexOf(' ', 240); s = s.slice(0, cut > 120 ? cut : 240).trim(); }
  return s;
}

async function ask(g, app, id, seats, req, mock) {
  const seat = seats[id];
  if (seat.provider === 'mock') {
    const json = require('./bots.js').bot(req.kind, { g, id, options: req.options, info: req.info }, app.botRng || (app.botRng = G.makeRng(g.seed + 99)));
    return { ok: true, json, ms: app.mockDelay || 0 };
  }
  const cfg = app.providers[seat.provider];
  let r = await caller(seat.provider, cfg, app, { system: SYSTEM, prompt: req.prompt, kind: req.kind });
  let retried = false;
  if (!r.ok) { const r2 = await caller(seat.provider, cfg, app, { system: SYSTEM, prompt: req.prompt, kind: req.kind }); r2.ms = (r2.ms || 0) + (r.ms || 0); r2.firstError = r.error; r = r2; retried = true; }
  if (r.meta && r.meta.path === 'agy-fallback') { app.mixed = true; g.timeline.push({ n: g.asked, type: 'warn', what: 'mixed', id, provider: seat.provider }); }
  if (!r.ok) g.timeline.push({ n: g.asked, type: 'warn', what: 'badCall', id, kind: req.kind, error: String(r.error || '').slice(0, 200) });
  if (app.stats) app.stats.push({ provider: seat.provider, kind: req.kind, ms: r.ms || 0, ok: !!r.ok, retried, error: r.ok ? null : String(r.error || '').slice(0, 120),
    costUsd: (r.usage && r.usage.costUsd) || 0, input: (r.usage && r.usage.input) || 0, output: (r.usage && r.usage.output) || 0, path: (r.meta && r.meta.path) || null });
  return r;
}

async function doTurn(g, app, seats) {
  const t = G.turnInfo(g);
  const req = turnPrompt(g, t.id, seats[t.id].persona);
  const r = await ask(g, app, t.id, seats, req);
  const j = (r.ok && r.json) || {};
  const k = pickNum(j.target, t.canAsk.length);
  G.applyTurn(g, {
    id: t.id, answer: t.question ? clip(j.answer) || FILLER : '', target: t.last ? null : (k >= 0 ? t.canAsk[k] : (j.target == null ? null : String(j.target))),
    question: t.last ? '' : clip(j.question) || 'แล้วตอนนี้ทำอะไรอยู่ล่ะ', thought: j.aside || '', suspect: j.suspect || '', guesses: j.guesses || '', ok: !!r.ok, error: r.ok ? undefined : r.error,
  });
}

async function doCheckpoint(g, app, seats) {
  const ids = g.players.map((p) => p.id);
  const res = await Promise.all(ids.map(async (id) => {
    const p = checkPrompt(g, id, seats[id].persona);
    const r = await ask(g, app, id, seats, p);
    const j = (r.ok && r.json) || {};
    const k = pickNum(j.target, p.options.length);
    const o = k >= 0 ? p.options[k] : { act: 'point', target: null }; // a bad pick points at nobody
    return [id, { ...o, confidence: Math.max(0, Math.min(100, parseInt(j.confidence, 10) || 0)), say: clip(j.say), thought: j.aside || '' }];
  }));
  return G.applyCheckpoint(g, Object.fromEntries(res));
}

async function doGuess(g, app, seats, id, last) {
  const p = guessPrompt(g, id, seats[id].persona, last);
  const r = await ask(g, app, id, seats, p);
  const j = (r.ok && r.json) || {};
  const k = pickNum(j.target, p.options.length);
  if (k < 0) g.timeline.push({ n: g.asked, type: 'illegal', id, what: 'place', got: j.target == null ? null : String(j.target), used: null });
  G.applyGuess(g, { id, place: k >= 0 ? p.options[k] : null, say: clip(j.say) || 'ขอเดาเลยละกัน', last });
}

async function doAccusation(g, app, seats, acc) {
  G.startAccusation(g, acc.by, acc.target, acc.say || `ฉันว่า${nm(g, acc.target)}นี่แหละสายลับ`, acc.pointers || [acc.by]);
  const d = defendPrompt(g, acc.target, seats[acc.target].persona);
  const rd = await ask(g, app, acc.target, seats, d);
  G.applyDefense(g, clip(rd.ok && rd.json && rd.json.say) || 'ไม่ใช่นะ ฟังก่อน');
  const voters = g.players.map((p) => p.id).filter((x) => x !== acc.by && x !== acc.target);
  const votes = await Promise.all(voters.map(async (id) => {
    const p = votePrompt(g, id, seats[id].persona);
    const r = await ask(g, app, id, seats, p);
    const j = (r.ok && r.json) || {};
    return [id, { yes: pickNum(j.target, 2) === 0, say: clip(j.say) }];
  }));
  G.applyVotes(g, Object.fromEntries(votes));
  if (g.phase === 'lastGuess') await doGuess(g, app, seats, g.lastGuesser, true);
}

async function doFinal(g, app, seats) {
  const ids = g.players.map((p) => p.id);
  const votes = await Promise.all(ids.map(async (id) => {
    const p = finalPrompt(g, id, seats[id].persona);
    const r = await ask(g, app, id, seats, p);
    const j = (r.ok && r.json) || {};
    const k = pickNum(j.target, p.options.length);
    return [id, { target: k >= 0 ? p.options[k] : null, say: clip(j.say) }];
  }));
  G.applyFinalVote(g, Object.fromEntries(votes));
  if (g.phase === 'lastGuess') await doGuess(g, app, seats, g.lastGuesser, true);
}

// a checkpoint's spy guess: the place was already picked in the checkpoint menu
function applyCheckpointGuess(g, r) { G.applyGuess(g, { id: r.id, place: r.place, say: r.say || `ที่นี่คือ${placeName(g, r.place)}ใช่ไหมล่ะ`, last: false }); }

module.exports = { SYSTEM, setCaller, rulesText, historyText, turnPrompt, checkPrompt, defendPrompt, votePrompt, finalPrompt, guessPrompt, pickNum, clip, ask, doTurn, doCheckpoint, doAccusation, doFinal, doGuess, applyCheckpointGuess };
