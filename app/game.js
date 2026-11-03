'use strict';
// game.js — rules of "ใครคือสายลับ?" (spec 2026-11-02 §3). No I/O, no UI: agent.js / bots.js decide, these functions apply.
// Everyone except the spy knows the place (+ a role there). Players ask each other in a chain; every few questions all
// point at a suspect (trialAt+ on one person → that person defends and the rest vote) or — the spy, from the last
// checkpoint on — reveal and guess the place. A caught spy still gets one last guess. The asker may only pick among those who have had the fewest turns, so the spy answers as often as anyone.
// Every step lands in g.timeline (the viewer and the edit replay it); `n` = questions asked so far.
const { PLACES } = require('./places.js');

// Park–Miller, but the seed is mixed first and the first draws are thrown away: with raw small seeds the first
// draw is ~seed·16807/2³¹ ≈ 0, so every early game dealt the first place (smoke_1 + trial_1 were both the hospital).
function makeRng(seed) {
  let s = Number((BigInt(seed >>> 0) * 2654435761n + 12345n) % 2147483647n) || 1;
  const next = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 8; i++) next();
  return next;
}
const pick = (g, arr) => arr[Math.floor(g.rng() * arr.length)];
function shuffle(g, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(g.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const push = (g, e) => { g.timeline.push({ n: g.asked, ...e }); };
const ids = (g) => g.players.map((p) => p.id);
const isSpy = (g, id) => g.spies.includes(id);

// guessFrom = questions asked before the spy may guess (default: the last checkpoint — trial_1–4 2026-11-02 the spy
// guessed right before anyone accused, every game)
function createGame({ players, seed = 1, spies = 1, spyIds = null, placeId = null, questions = 18, checkEvery = 6, passRatio = 0.75, lastGuess = true, guessFrom = null, trialAt = 3, places = PLACES }) {
  if (guessFrom == null) guessFrom = Math.floor((questions - 1) / checkEvery) * checkEvery;
  const g = {
    players: players.map((p) => ({ ...p })), seed, rng: makeRng(seed), places,
    opts: { spies, questions, checkEvery, passRatio, lastGuess, guessFrom, trialAt },
    asked: 0, pending: null, first: null, checkedAt: -1, acc: null, catchBy: null, cleared: [],
    phase: 'turn', winner: null, how: null, points: null, timeline: [],
  };
  g.place = placeId ? places.find((p) => p.id === placeId) : pick(g, places);
  if (!g.place) throw new Error(`unknown place ${placeId}`);
  g.spies = spyIds ? spyIds.slice() : shuffle(g, ids(g)).slice(0, spies);
  const roles = shuffle(g, g.place.roles);
  g.roles = {};
  ids(g).filter((id) => !isSpy(g, id)).forEach((id, i) => { g.roles[id] = roles[i]; });
  g.first = pick(g, ids(g));
  g.turns = Object.fromEntries(ids(g).map((id) => [id, id === g.first ? 1 : 0]));
  push(g, { type: 'deal', place: g.place.id, placeName: g.place.name, roles: { ...g.roles }, spies: g.spies.slice(),
    players: g.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })), first: g.first, opts: { ...g.opts },
    places: places.map((p) => ({ id: p.id, name: p.name, family: p.family || null })) });
  return g;
}

function turnInfo(g) {
  const id = g.pending ? g.pending.to : g.first;
  const from = g.pending ? g.pending.from : null;
  const open = ids(g).filter((x) => x !== id && x !== from);
  const low = Math.min(...open.map((x) => g.turns[x]));
  return { id, question: g.pending ? { from, q: g.pending.q } : null, canAsk: open.filter((x) => g.turns[x] === low), last: g.asked >= g.opts.questions };
}

// d = { id, answer, target, question, thought, suspect, guesses, ok }
function applyTurn(g, d) {
  if (g.phase !== 'turn') throw new Error(`applyTurn in phase ${g.phase}`);
  const t = turnInfo(g);
  if (t.question) push(g, { type: 'answer', id: t.id, to: t.question.from, text: d.answer || '' });
  push(g, { type: 'thought', id: t.id, text: d.thought || '', suspect: d.suspect || '', guesses: d.guesses || '', ok: d.ok !== false, ...(d.error ? { error: d.error } : {}) });
  if (t.last) { g.pending = null; g.phase = 'final'; return; }
  let to = d.target;
  if (!t.canAsk.includes(to)) { const used = pick(g, t.canAsk); push(g, { type: 'illegal', id: t.id, what: 'target', got: to == null ? null : String(to), used }); to = used; }
  g.asked++;
  g.turns[to]++;
  g.pending = { from: t.id, to, q: d.question || '' };
  push(g, { type: 'ask', id: t.id, to, text: d.question || '' });
}

function isCheckpoint(g) {
  const o = g.opts;
  return g.phase === 'turn' && g.asked > 0 && g.asked % o.checkEvery === 0 && g.asked < o.questions && g.checkedAt !== g.asked;
}

const canGuess = (g, id) => isSpy(g, id) && g.asked >= g.opts.guessFrom;

// trial_1–8 2026-11-02: 0 accusations in 8 games (one person risked the game alone) → VreKi picked option A:
// everyone must point at a suspect; no "wait"
function checkOptions(g, id) {
  const out = ids(g).filter((t) => t !== id && !g.cleared.includes(t)).map((t) => ({ act: 'point', target: t }));
  if (canGuess(g, id)) for (const p of g.places) out.push({ act: 'guess', place: p.id });
  return out;
}

// decisions = { id: { act, target, place, confidence, say, thought } } → what happens next (or null = keep asking)
// a spy's guess comes first · else the person most pointed at (trialAt+, ties broken by the seed) goes on trial and the
// most confident of their pointers speaks
function applyCheckpoint(g, decisions) {
  g.checkedAt = g.asked;
  const clean = {};
  for (const id of ids(g)) {
    const d = decisions[id];
    if (!d) continue;
    clean[id] = { act: d.act || 'point', target: d.target || null, place: d.place || null, confidence: +d.confidence || 0, say: d.say || '', thought: d.thought || '' };
  }
  push(g, { type: 'checkpoint', decisions: clean });
  const best = (list) => {
    if (!list.length) return null;
    const top = Math.max(...list.map(([, d]) => d.confidence));
    return pick(g, list.filter(([, d]) => d.confidence === top));
  };
  const valid = Object.entries(clean);
  const guess = best(valid.filter(([id, d]) => d.act === 'guess' && canGuess(g, id) && g.places.some((p) => p.id === d.place)));
  if (guess) return { kind: 'guess', id: guess[0], place: guess[1].place, say: guess[1].say };
  const pointing = valid.filter(([id, d]) => d.act === 'point' && d.target !== id && ids(g).includes(d.target) && !g.cleared.includes(d.target));
  const count = {};
  for (const [, d] of pointing) count[d.target] = (count[d.target] || 0) + 1;
  const top = Math.max(0, ...Object.values(count));
  if (top < g.opts.trialAt) return null;
  const target = pick(g, Object.keys(count).filter((t) => count[t] === top));
  const by = best(pointing.filter(([, d]) => d.target === target));
  return { kind: 'accuse', by: by[0], target, say: by[1].say, pointers: pointing.filter(([, d]) => d.target === target).map(([id]) => id) };
}

function startAccusation(g, by, target, say, pointers = [by]) {
  g.phase = 'accuse';
  g.acc = { by, target, pointers: pointers.slice() };
  push(g, { type: 'accuse', id: by, target, pointers: pointers.slice(), text: say || '' });
}

function applyDefense(g, say) { push(g, { type: 'defend', id: g.acc.target, text: say || '' }); }

function end(g, winner, how) {
  g.phase = 'over'; g.winner = winner; g.how = how;
  g.points = score(g);
  push(g, { type: 'over', winner, how, points: { ...g.points }, place: g.place.id, spies: g.spies.slice() });
}

// via: 'accuse' (vote passed) | 'final' (final vote)
function convict(g, id, via) {
  const spy = isSpy(g, id);
  push(g, { type: 'reveal', id, isSpy: spy, via });
  // trial_11/12 2026-11-02: voters never risked a wrong catch (it ended the game) → VreKi: a trial's wrong catch only
  // clears that person and play goes on; the final vote's wrong catch still loses
  if (!spy && via === 'accuse') { g.cleared.push(id); g.phase = 'turn'; g.acc = null; return; }
  if (!spy) return end(g, 'spy', 'wrongVote');
  // trial_13 2026-11-02: caught at 4 questions, still guessed right → VreKi: caught by a trial = the spy loses at once
  if (via === 'accuse') { g.catchBy = g.acc.pointers.slice(); return end(g, 'town', 'trial'); }
  g.catchBy = null;
  if (g.opts.lastGuess) { g.phase = 'lastGuess'; g.lastGuesser = id; } else end(g, 'town', 'caught');
}

// votes = { voterId: { yes, say } } — voters are everyone but the accuser and the accused
function applyVotes(g, votes) {
  const { by, target } = g.acc;
  const voters = ids(g).filter((id) => id !== by && id !== target);
  let yes = 0;
  for (const v of voters) {
    const y = !!(votes[v] && votes[v].yes);
    if (y) yes++;
    push(g, { type: 'vote', id: v, yes: y, text: (votes[v] && votes[v].say) || '' });
  }
  const need = Math.ceil(g.opts.passRatio * voters.length);
  const pass = yes >= need;
  push(g, { type: 'voteResult', by, target, yes, need, pass });
  if (pass) return convict(g, target, 'accuse');
  g.phase = 'turn'; g.acc = null;
}

function applyGuess(g, { id, place, say, last }) {
  const right = place === g.place.id;
  push(g, { type: 'guess', id, place, right, last: !!last, text: say || '' });
  if (right) end(g, 'spy', last ? 'lastGuess' : 'guessed');
  else end(g, 'town', last ? 'caught' : 'spyWrong');
}

// votes = { voterId: { target, say } }; self-votes and unknown ids are dropped
function applyFinalVote(g, votes) {
  const counts = {};
  for (const id of ids(g)) {
    const v = votes[id];
    const t = v && v.target !== id && ids(g).includes(v.target) ? v.target : null;
    if (t) counts[t] = (counts[t] || 0) + 1;
    push(g, { type: 'final', id, target: t, text: (v && v.say) || '' });
  }
  const top = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((k) => counts[k] === top);
  const winnerId = top > 0 && leaders.length === 1 ? leaders[0] : null;
  push(g, { type: 'finalResult', counts, top: winnerId });
  if (!winnerId) return end(g, 'spy', 'tie');
  convict(g, winnerId, 'final');
}

// spy survives +2 · spy guesses right / innocent convicted +4 · town win +1 each · everyone who pointed at a spy caught by a trial +2 instead
function score(g) {
  const pts = Object.fromEntries(ids(g).map((id) => [id, 0]));
  if (g.winner === 'spy') { for (const s of g.spies) pts[s] = g.how === 'tie' ? 2 : 4; }
  else if (g.winner === 'town') {
    for (const id of ids(g)) if (!isSpy(g, id)) pts[id] = 1;
    if (g.how === 'trial' && g.catchBy) for (const id of g.catchBy) if (!isSpy(g, id)) pts[id] = 2;
  }
  return pts;
}

function campScore(g, seatOf) {
  const out = {};
  for (const [id, n] of Object.entries(g.points || score(g))) out[seatOf[id]] = (out[seatOf[id]] || 0) + n;
  return out;
}

module.exports = { createGame, turnInfo, applyTurn, isCheckpoint, checkOptions, applyCheckpoint, startAccusation, applyDefense, applyVotes, applyGuess, applyFinalVote, score, campScore, makeRng, isSpy };
