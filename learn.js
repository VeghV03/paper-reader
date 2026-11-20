// The reading record and what the paper learns from it, as reading.py, topics.py and learn.py do
// on a computer (step 3, D70 to D72, D80 to D82). Plain functions of the record's events and the edition's index
// (edition.py), so the same evidence gives the same why line here as there. The draw samples with
// its own seeded generator: the same day gives the same order, though not Python's.
"use strict";

const FINISHED = 0.9; // of the article read
const WPM = 250; // a third of the reading time at this pace, so a quick scroll does not count
const RECENT = 14; // days of opened pieces in the brief
const STEER = 28; // days without an open that make a steered section silent
const HALF_LIFE = 30; // days (D26)
const OPENED = 0.25; // an open that went no further (D25)
const LESS = 3; // misses one "less of this" counts as (D29)
const LAST = 5; // showings the why line counts back over
const KINDS = ["highlight", "question"];
const DAY_MS = 86400000;

const at = (e) => Date.parse(e.t);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOf = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const addDays = (day, n) => iso(new Date(startOf(day) + n * DAY_MS + 12 * 3600000)); // noon: a DST shift stays on the day
const byTime = (evs) => [...evs].sort((a, b) => at(a) - at(b));
const fill = (s, v) => (s ? s.replace(/\{(\w+)\}/g, (_, k) => v[k]) : ""); // a label an older edition lacks: nothing
// the Monday (UTC) of an event's week: the record's file for it (D76)
const week = (t) => { const d = new Date(Date.parse(t)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

function state(evs) {
  const out = {};
  for (const e of evs) {
    if (!["seen", "look", "open", "read", "keep"].includes(e.ev)) continue;
    const s = out[e.id] || (out[e.id] = { seen: false, looked: false, opened: false, progress: 0, ms: 0, kept: null });
    if (e.ev === "seen") s.seen = true;
    else if (e.ev === "look") s.seen = s.looked = true;
    else if (e.ev === "open") s.seen = s.looked = s.opened = true;
    else if (e.ev === "read") {
      s.seen = s.looked = s.opened = true;
      s.ms += Math.max(0, Math.trunc(e.ms) || 0);
      s.progress = Math.max(s.progress, Math.min(1, Number(e.progress) || 0));
    } else s.kept = Boolean(e.kept);
  }
  return out;
}
const finished = (s, words) => Boolean(s) && s.progress >= FINISHED && s.ms >= ((words || 0) / WPM) * 60000 / 3;
const kept = (piece, s) => (s && s.kept !== null ? s.kept : Boolean(piece.saved));

// the reader's live marks by id: a mark event adds one, an unmark takes it away
function marks(evs) {
  const out = {};
  for (const e of byTime(evs)) {
    if (e.ev === "mark" && KINDS.includes(e.kind) && e.text && e.piece) out[e.id] = { id: e.id, piece: e.piece, kind: e.kind, text: e.text, t: e.t };
    else if (e.ev === "unmark") delete out[e.id];
  }
  return out;
}
async function markId(piece, kind, text) { // as learn.add_mark
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${piece}\n${kind}\n${text}`)));
  return "h-" + [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

// per piece, when "less of this" was pressed, for presses not taken back
function pressed(evs) {
  const out = {};
  for (const e of byTime(evs)) {
    if (e.ev === "less" && !(e.id in out)) out[e.id] = at(e);
    else if (e.ev === "less_undo") delete out[e.id];
  }
  return out;
}

// per steered section and topic, what the record held before `before` (ms)
function evidence(index, evs, before) {
  const early = byTime(evs.filter((e) => at(e) < before));
  const st = state(early);
  const firstLook = {};
  for (const e of early) if (["look", "open", "read"].includes(e.ev) && !(e.id in firstLook)) firstLook[e.id] = at(e);
  const marked = new Set(Object.values(marks(early)).map((m) => m.piece));
  const less = pressed(early);
  const out = {};
  for (const [sid, ts] of Object.entries(index.steered)) out[sid] = Object.fromEntries(ts.map((t) => [t, { trials: [], showings: [], less: [] }]));
  const pieces = Object.entries(index.pieces).sort(([a, p], [b, q]) => (p.day + a < q.day + b ? -1 : 1));
  for (const [id, p] of pieces) {
    const topic = (out[p.section] || {})[p.topic];
    const s = st[id];
    if (!topic || !s || !s.looked) continue;
    const fin = finished(s, p.words);
    const kp = kept(p, s) || marked.has(id);
    const success = fin || kp ? 1 : s.opened ? OPENED : 0;
    topic.trials.push([id in firstLook ? firstLook[id] : startOf(p.day), success, 1 - success]);
    topic.showings.push(fin ? "finished" : kp ? "kept" : s.opened ? "opened" : "passed");
    if (id in less) {
      topic.trials.push([less[id], 0, LESS]);
      topic.less.push(less[id]);
    }
  }
  return out;
}
function estimate(topic, now) {
  let a = 1, b = 1;
  for (const [when, success, miss] of topic.trials) {
    const w = 0.5 ** (Math.max(0, now - when) / DAY_MS / HALF_LIFE);
    a += w * success;
    b += w * miss;
  }
  return [a, b];
}

// Thompson sampling with a generator seeded by the day and section
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gamma(shape, rng) { // Marsaglia and Tsang; every shape here is at least 1
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    if (Math.log(1 - rng()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
const beta = (a, b, rng) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)); };

async function draw(index, evs, day) { // {order, try, tries}: decisions, no counts (D47)
  const now = startOf(day), out = {};
  for (const [sid, topics] of Object.entries(evidence(index, evs, now))) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${sid}`)));
    const rng = mulberry32(new DataView(hash.buffer).getUint32(0));
    const names = Object.keys(topics);
    const est = Object.fromEntries(names.map((t) => [t, estimate(topics[t], now)]));
    const sample = Object.fromEntries(names.map((t) => [t, beta(...est[t], rng)]));
    const order = [...names].sort((x, y) => sample[y] - sample[x]);
    const tries = [...order].sort((x, y) => est[x][0] + est[x][1] - (est[y][0] + est[y][1])); // the least evidence first
    out[sid] = { order, try: tries[0], tries };
  }
  return out;
}

// shown for STEER days or more, with nothing opened in the last STEER
function silent(index, st, sid, today) {
  const first = addDays(today, -(STEER - 1));
  const ever = Object.entries(index.pieces).filter(([id, p]) => p.section === sid && st[id] && st[id].looked)
    .sort(([a, p], [b, q]) => (p.day + a < q.day + b ? -1 : 1));
  return ever.length > 0 && ever[0][1].day < first && !ever.some(([id, p]) => p.day >= first && st[id].opened);
}

// the why line of a steered piece, from the record as it stood on the issue's morning
function why(index, evs, id, labels) {
  const p = index.pieces[id];
  if (!p) return null;
  const topic = (evidence(index, evs, startOf(p.day))[p.section] || {})[p.topic];
  if (!topic) return null;
  const last = topic.showings.slice(-LAST), n = last.length, name = p.topic;
  if (!n) return fill(labels.why_new, { topic: name });
  if (p.fit === "tries" && topic.less.length) return fill(labels.why_less, { topic: name, date: iso(new Date(topic.less.at(-1))) });
  for (const [outcome, key] of [["finished", "why_finished"], ["kept", "why_kept"], ["opened", "why_opened"]]) {
    const k = last.filter((x) => x === outcome || (outcome === "opened" && x !== "passed")).length;
    if (k) return fill(labels[key + (n === 1 ? "_one" : "")], { topic: name, k, n });
  }
  return fill(labels["why_passed" + (n === 1 ? "_one" : "")], { topic: name, n });
}

// cards: FSRS 6 as the Mac's learn.py runs it (py-fsrs 6.3.3, no learning steps, no fuzz), with
// the default parameters until a fit of the reader's own is back (D81)
const FSRS = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const RETENTION = 0.9, MAX_INTERVAL = 36500, NEW_A_DAY = 10;
const RATINGS = { again: 1, good: 3 };
const DECAY = -FSRS[20], FACTOR = 0.9 ** (1 / DECAY) - 1;
const clampD = (d) => Math.min(Math.max(d, 1), 10);
const clampS = (x) => Math.max(x, 0.001);
const roundEven = (x) => { const f = Math.floor(x), r = x - f; return r > 0.5 ? f + 1 : r < 0.5 ? f : f % 2 ? f + 1 : f; }; // Python's round
const initD = (r) => FSRS[4] - Math.E ** (FSRS[5] * (r - 1)) + 1;
const nextD = (d, r) => clampD(FSRS[7] * initD(4) + (1 - FSRS[7]) * (d + (10 - d) * -(FSRS[6] * (r - 3)) / 9));
const shortS = (x, r) => { let up = Math.E ** (FSRS[17] * (r - 3 + FSRS[18])) * x ** -FSRS[19]; if (r > 1) up = Math.max(up, 1); return clampS(x * up); };
const forgetS = (d, x, R) => Math.min(FSRS[11] * d ** -FSRS[12] * ((x + 1) ** FSRS[13] - 1) * Math.E ** ((1 - R) * FSRS[14]), x / Math.E ** (FSRS[17] * FSRS[18]));
const recallS = (d, x, R) => x * (1 + Math.E ** FSRS[8] * (11 - d) * x ** -FSRS[9] * (Math.E ** ((1 - R) * FSRS[10]) - 1));
const interval = (x) => Math.min(Math.max(roundEven((x / FACTOR) * (RETENTION ** (1 / DECAY) - 1)), 1), MAX_INTERVAL);
function review(card, r, when) { // card {s, d, last, due} in ms; a new card is {}
  const out = { ...card };
  if (out.s == null) { out.s = clampS(FSRS[r - 1]); out.d = clampD(initD(r)); }
  else {
    const days = Math.floor((when - out.last) / DAY_MS);
    if (days < 1) out.s = shortS(out.s, r);
    else {
      const R = (1 + FACTOR * Math.max(0, days) / out.s) ** DECAY;
      out.s = clampS(r === 1 ? forgetS(out.d, out.s, R) : recallS(out.d, out.s, R));
    }
    out.d = nextD(out.d, r);
  }
  out.due = when + interval(out.s) * DAY_MS;
  out.last = when;
  return out;
}
// per card id: its FSRS state and when it was first and last reviewed
function schedule(cards, evs) {
  const out = Object.fromEntries(Object.keys(cards).map((id) => [id, { card: {}, first: null, last: null }]));
  for (const e of byTime(evs)) {
    const s = out[e.id], r = RATINGS[e.rating];
    if (e.ev !== "review" || !s || !r) continue;
    s.card = review(s.card, r, at(e));
    s.first = s.first ?? at(e);
    s.last = at(e);
  }
  return out;
}
// the piece a card comes from, through its mark
function cardPiece(card, evs, games = {}) { // a card's piece: through the mark, or the missed game, it came from
  for (const e of evs) if (e.ev === "mark" && e.id === card.from && e.piece) return e.piece;
  return games[card.from] || card.from;
}
// the one card after the piece `after`, as learn.due: the most overdue reviewed card, else a new
// one while fewer than NEW_A_DAY were new today; never one from that piece or reviewed today
function due(cards, evs, after, now = Date.now(), games = {}) {
  const sched = schedule(cards, evs), today = (t) => t != null && iso(new Date(t)) === iso(new Date(now));
  const open = Object.entries(sched).filter(([id, s]) => cardPiece(cards[id], evs, games) !== after && !today(s.last));
  const key = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const old = open.filter(([, s]) => s.first != null && s.card.due <= now).map(([id, s]) => [s.card.due, id]).sort(key);
  if (old.length) return { id: old[0][1], ...cards[old[0][1]] };
  if (Object.values(sched).filter((s) => today(s.first)).length >= NEW_A_DAY) return null;
  const fresh = open.filter(([, s]) => s.first == null).map(([id]) => [cards[id].day, id]).sort(key);
  return fresh.length ? { id: fresh[0][1], ...cards[fresh[0][1]] } : null;
}
// the finished pieces of the RECENT days before `day` with no live mark and no card, newest first
function toCard(index, evs, day) {
  const st = state(evs), first = addDays(day, -(RECENT - 1));
  const marked = new Set(Object.values(marks(evs)).map((m) => m.piece));
  const carded = new Set(Object.values(index.cards || {}).map((c) => c.from));
  return Object.entries(index.pieces).filter(([id, p]) => p.day >= first && p.day <= day && finished(st[id], p.words)
    && !marked.has(id) && !carded.has(id)).sort(([a, p], [b, q]) => (q.day + b < p.day + a ? -1 : 1)).map(([id]) => id);
}

// running stories, as reading.py and the Mac's server do: where the reader left each one is the
// newest day of a piece of it they opened, or of an update they opened, before `before`
function leftOff(index, evs, th, before, st = state(evs)) {
  const mine = new Set((th.entries || []).map((x) => x && x.piece).filter(Boolean));
  for (const [id, p] of Object.entries(index.pieces)) if (p.thread === th.id) mine.add(id);
  const days = [...mine].filter((id) => index.pieces[id] && st[id] && st[id].opened).map((id) => index.pieces[id].day);
  for (const e of evs) if (e.ev === "since" && e.id === th.id) days.push(String(e.upto || e.t.slice(0, 10)));
  const before_ = days.filter((d) => d < before).sort();
  return before_.length ? before_.at(-1) : null;
}
const since = (th, left, upto) => [...(th.entries || [])].reverse().filter((x) => (left || "") < x.day && x.day <= upto);
// Since you left: each story the reader follows with news for them in the day's issue, newest first
function moved(index, evs, threads, day, pieceIds) {
  const st = state(evs), out = [];
  for (const th of threads) {
    const left = leftOff(index, evs, th, day, st);
    if (!left) continue;
    const piece = pieceIds.find((id) => index.pieces[id] && index.pieces[id].thread === th.id && !index.pieces[id].saved) || null;
    const fresh = since(th, left, day);
    if (fresh.length || piece) out.push({ thread: th, piece, left, new: fresh, last: fresh.length ? fresh[0].day : day });
  }
  return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
}
// the story above a piece: updates new to the reader, then the rest; never read: the newest three
function story(index, evs, th, id, day) {
  const left = leftOff(index, evs, th, day);
  const mine = [...(th.entries || [])].reverse().filter((x) => x.piece !== id && x.day <= day);
  const fresh = left ? mine.filter((x) => left < x.day) : mine.slice(0, 3);
  return { left, new: fresh, old: mine.filter((x) => !fresh.includes(x)) };
}

// the next issue: today's until the morning run's time, then tomorrow's
function nextDay(morning, now = new Date()) {
  const [h, m] = String(morning || "5:07").split(":").map(Number);
  const today = iso(now);
  return now.getHours() * 60 + now.getMinutes() < h * 60 + m ? today : addDays(today, 1);
}

// the brief: decisions only, sealed with the run key for the morning run (D47, brief.py)
// per game, the first answer, as reading.games: a pick or a skip; a crossword's solved entries;
// Lede's tries, and whether it was solved, from its guesses (R7, R9)
function played(evs) {
  const out = {};
  for (const e of evs) {
    if (e.ev !== "game") continue;
    if (typeof e.guess === "string") {
      const g = out[e.id] = out[e.id] || { tries: 0, solved: false };
      if (!g.solved) { g.tries += 1; g.solved = e.right === true; }
    } else if (Number.isInteger(e.entry)) { out[e.id] = out[e.id] || { solved: [] }; if (!out[e.id].solved.includes(e.entry)) out[e.id].solved.push(e.entry); }
    else if (!(e.id in out)) out[e.id] = e.skipped ? { skipped: true } : { pick: e.pick, right: e.right };
  }
  return out;
}
// Lede: each letter of a guess in place, elsewhere in the word, or not in it; a letter is marked
// as often as the word has it (R5)
function ledeScore(word, guess) {
  const out = Array(5).fill("no"), left = [...word];
  for (let i = 0; i < 5; i++) if (guess[i] === word[i]) { out[i] = "in"; left[i] = null; }
  for (let i = 0; i < 5; i++) if (out[i] !== "in") { const k = left.indexOf(guess[i]); if (k >= 0) { out[i] = "near"; left[k] = null; } }
  return out;
}
const gameDay = (id) => (String(id).match(/^[plxw]-(\d{4}-\d{2}-\d{2})/) || [])[1];
async function brief(index, evs, day, threads = []) {
  const st = state(evs);
  const steer = await draw(index, evs, day);
  for (const sid of Object.keys(steer)) steer[sid].silent = silent(index, st, sid, day);
  const first = addDays(day, -(RECENT - 1));
  return {
    made: new Date().toISOString(), day, steer,
    marks: Object.values(marks(evs)).filter((m) => iso(new Date(at(m))) >= first) // the run answers within days (D76)
      .map(({ id, piece, kind, text }) => ({ id, piece, kind, text })),
    opened: Object.entries(index.pieces).filter(([id, p]) => p.day >= first && st[id] && st[id].opened).map(([id]) => id),
    to_card: toCard(index, evs, day),
    stories: Object.fromEntries(threads.map((th) => [th.id, leftOff(index, evs, th, day, st)]).filter(([, left]) => left)),
    // what was picked, not whether it was right: the run checks it against the issue (D82)
    games: Object.fromEntries(Object.entries(played(evs)).filter(([id]) => gameDay(id) >= first && gameDay(id) <= day)
      .map(([id, g]) => [id, "tries" in g ? { tries: g.tries, solved: g.solved } // the guesses stay here (R9)
        : g.solved ? { solved: [...g.solved].sort((a, b) => a - b) } : g.skipped ? { skipped: true } : { pick: g.pick }])),
  };
}
