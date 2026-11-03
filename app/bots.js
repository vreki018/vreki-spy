'use strict';
// bots.js — mock seats for "ใครคือสายลับ?": free, instant answers in the same JSON shape the AI returns.
// They only exist to drive every path of the engine (tests, tuning, viewer work) — they cheat (read the cards) on purpose.
const G = require('./game.js');

const ANSWERS = ['ก็ยุ่งตามปกตินะ', 'วันนี้คนเยอะกว่าปกติหน่อย', 'ก็มาเพราะงานนั่นแหละ', 'ไม่ได้แย่นะ แต่ร้อนไปหน่อย', 'ถามยากจัง ขอตอบว่าชอบที่นี่ละกัน'];
const QUESTIONS = ['วันนี้เหนื่อยไหม', 'มาที่นี่บ่อยหรือเปล่า', 'แต่งตัวแบบนี้มาเพราะอะไร', 'ตอนนี้กำลังรออะไรอยู่', 'ที่นี่มีอะไรที่ไม่ชอบไหม'];
const one = (rng, a) => a[Math.floor(rng() * a.length)];
const num = (i) => String(i + 1);

function bot(kind, { g, id, options, info }, rng) {
  const spy = G.isSpy(g, id);
  const others = g.players.map((p) => p.id).filter((x) => x !== id);
  if (kind === 'turn') {
    const n = options.length;
    const sus = one(rng, others);
    return {
      aside: '', answer: info && info.question ? one(rng, ANSWERS) : '', target: n ? num(Math.floor(rng() * n)) : '',
      question: n ? one(rng, QUESTIONS) : '', suspect: g.players.find((p) => p.id === sus).name,
      guesses: spy ? g.places.slice(0, 3).map((p, i) => `${p.name}:${[50, 30, 20][i]}`).join(',') : '',
    };
  }
  if (kind === 'check') {
    const idx = (pred) => options.findIndex(pred);
    let k;
    const guesses = options.map((o, i) => (o.act === 'guess' ? i : -1)).filter((i) => i >= 0);
    if (guesses.length && rng() < 0.2) {
      const right = idx((o) => o.act === 'guess' && o.place === g.place.id);
      k = rng() < 0.4 && right >= 0 ? right : one(rng, guesses);
    } else {
      // town leans on the spy a little, so trials land on the spy and on innocents
      const pts = options.map((o, i) => (o.act === 'point' ? i : -1)).filter((i) => i >= 0);
      const atSpy = idx((o) => o.act === 'point' && G.isSpy(g, o.target));
      k = !spy && atSpy >= 0 && rng() < 0.2 ? atSpy : one(rng, pts);
    }
    return { aside: '', target: num(k), confidence: String(Math.floor(rng() * 101)), say: 'ฉันว่ามีอะไรแปลกๆ' };
  }
  if (kind === 'last') return { aside: '', say: 'ไม่ใช่นะ ฟังก่อน' };
  if (kind === 'vote') {
    if (options[0] === true) { const p = G.isSpy(g, g.acc.target) ? 0.6 : 0.45; return { aside: '', target: rng() < p ? '1' : '2', say: 'ก็ตามนั้น' }; }
    if (g.places.some((p) => p.id === options[0])) { const right = options.indexOf(g.place.id); return { aside: '', target: num(rng() < 0.4 ? right : Math.floor(rng() * options.length)), say: 'ขอเดาเลย' }; }
    const spyIdx = options.findIndex((x) => G.isSpy(g, x));
    return { aside: '', target: num(spyIdx >= 0 && rng() < 0.35 ? spyIdx : Math.floor(rng() * options.length)), say: 'คนนี้แหละ' };
  }
  throw new Error(`bot: unknown kind ${kind}`);
}

module.exports = { bot };
