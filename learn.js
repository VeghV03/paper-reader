// The reading record and what the paper learns from it, as reading.py and topics.py do on a
// computer (step 3, D70 to D72). Plain functions of the record's events and the edition's index
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
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]);
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

// the next issue: today's until the morning run's time, then tomorrow's
function nextDay(morning, now = new Date()) {
  const [h, m] = String(morning || "5:07").split(":").map(Number);
  const today = iso(now);
  return now.getHours() * 60 + now.getMinutes() < h * 60 + m ? today : addDays(today, 1);
}

// the brief: decisions only, sealed with the run key for the morning run (D47, brief.py)
async function brief(index, evs, day) {
  const st = state(evs);
  const steer = await draw(index, evs, day);
  for (const sid of Object.keys(steer)) steer[sid].silent = silent(index, st, sid, day);
  const first = addDays(day, -(RECENT - 1));
  return {
    made: new Date().toISOString(), day, steer,
    marks: Object.values(marks(evs)).filter((m) => iso(new Date(at(m))) >= first) // the run answers within days (D76)
      .map(({ id, piece, kind, text }) => ({ id, piece, kind, text })),
    opened: Object.entries(index.pieces).filter(([id, p]) => p.day >= first && st[id] && st[id].opened).map(([id]) => id),
  };
}
