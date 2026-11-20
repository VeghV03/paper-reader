// The morning paper on the phone (decisions D63 to D75). It fetches the sealed edition from the
// reader's private data repository through GitHub's API and opens it here with the run key. What
// the reader does is kept on the phone, and written back on leaving a piece or the page (D71):
// this phone's record sealed with the record key, which nothing but the reader's devices holds,
// and the brief (learn.js) sealed with the run key, for the morning run (D46, D47).
//
// Neither key leaves the phone, and the browser hands neither to any script, this one included.
// Article HTML is cut to a short list of tags with no attributes before it is shown, and the
// page's policy runs no script but its own, so text from an outlet cannot act.
"use strict";

const API = location.hostname === "localhost" ? location.origin : "https://api.github.com"; // localhost: a test copy
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // as vault.py: no 0/O or 1/I
const DATA = "paper-data"; // the cache of sealed files, kept for the latest issue only (D37)
const WAIT = 5000; // ms to wait for GitHub before showing the saved copy
const LOOK_MS = 2000; // a headline on screen this long, with the page in front, was looked at
const BEAT = 15000; // ms between saves of the reading time
const TAGS = new Set(["P", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "EM", "I", "STRONG", "B",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BR", "HR", "SUB", "SUP", "CODE", "PRE", "SPAN", "DIV"]);
const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "NOSCRIPT", "FORM"]);
const BLOCKS = "p, li, blockquote, h2, h3, h4, td, th";
const SETUP = {
  en: { repo: "Data repository", token: "GitHub token", code: "Recovery code", open: "Open the paper",
    bad_code: "A recovery code is 24 letters and digits.", no_repo: "That token can't read that repository.",
    wrong_key: "That code doesn't open this paper.", offline: "No connection, and this isn't saved on the phone.",
    forget: "Forget this phone", no_issue: "No issue yet.",
    again: "The paper now remembers what you read: paste a token that can write, and the code once more.",
    cant_write: "Not saved: the token can't write." },
  hu: { repo: "Adattároló", token: "GitHub-token", code: "Helyreállító kód", open: "Az újság megnyitása",
    bad_code: "A helyreállító kód 24 betű és szám.", no_repo: "Ez a token nem olvassa azt a tárolót.",
    wrong_key: "Ez a kód nem nyitja ezt az újságot.", offline: "Nincs kapcsolat, és ez nincs elmentve a telefonon.",
    forget: "A telefon elfelejtése", no_issue: "Még nincs szám.",
    again: "Az újság mostantól megjegyzi, mit olvasol: illessz be egy írni is tudó tokent, és még egyszer a kódot.",
    cant_write: "Nincs mentve: a token nem tud írni." },
};
const enc = (x) => new TextEncoder().encode(x);
const $main = document.getElementById("main");
let cfg = null; // {repo, token, key, rkey, device}
let own = []; // this phone's record, oldest first
let dirty = new Set(); // its weeks not yet written back
let lang = navigator.language.toLowerCase().startsWith("hu") ? "hu" : "en";
let cantWrite = false;
const s = () => SETUP[lang];

// storage: the phone's own, under its passcode encryption (D39, D65)

function idb() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open("paper", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((ok, fail) => {
    const tx = db.transaction("kv", mode);
    const r = fn(tx.objectStore("kv"));
    tx.oncomplete = () => ok(r && r.result);
    tx.onerror = () => fail(tx.error);
  });
}
const get = (k) => kv("readonly", (st) => st.get(k));
const put = (k, v) => kv("readwrite", (st) => st.put(v, k));
const forget = async () => { await kv("readwrite", (st) => st.clear()); await caches.delete(DATA); };
const saveOwn = () => kv("readwrite", (st) => { st.put(own, "events"); st.put([...dirty], "dirty"); });
let again = null; // weeks touched while a write is under way
const touch = (e) => { const w = week(e.t); dirty.add(w); again?.add(w); };
function log(ev) {
  const e = { t: new Date().toISOString(), ...ev };
  own.push(e);
  touch(e);
  saveOwn();
  return e;
}

// keys and seals, as cloud.py and vault.py

function normal(code) {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 24 || [...raw].some((c) => !ALPHABET.includes(c))) throw new Error(s().bad_code);
  return raw.match(/.{4}/g).join("-");
}
async function deriveKey(code, info) { // "run v1": the run's key; "record v1": the record's
  const base = await crypto.subtle.importKey("raw", enc(normal(code)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc("morning-paper"), info: enc(info) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); // not extractable
}
const runKey = (code) => deriveKey(code, "run v1");
async function unseal(key, rel, buf, raw = false) {
  const b = new Uint8Array(buf);
  if (b.length < 31 || String.fromCharCode(b[0], b[1], b[2]) !== "pf1") throw new Error("not sealed");
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(3, 15), additionalData: enc(rel) }, key, b.slice(15));
  } catch {
    throw Object.assign(new Error(s().wrong_key), { wrongKey: true });
  }
  const text = new TextDecoder().decode(plain);
  return raw ? text : JSON.parse(text);
}
async function seal(key, rel, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc(rel) }, key, enc(text)));
  const out = new Uint8Array(15 + ct.length);
  out.set(enc("pf1"));
  out.set(iv, 3);
  out.set(ct, 15);
  return out;
}

// GitHub, with the saved copy when it does not answer in time

function gh(c, path, raw, init = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), init.method ? 4 * WAIT : WAIT);
  return fetch(`${API}/repos/${c.repo}/contents/${path}`, {
    ...init, cache: "no-store", referrerPolicy: "no-referrer", signal: ctl.signal,
    headers: { Authorization: `Bearer ${c.token}`, "X-GitHub-Api-Version": "2022-11-28",
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" },
  }).finally(() => clearTimeout(timer));
}
const saved = (rel) => `https://paper.invalid/${rel}`; // a cache key, never fetched
async function cached(rel, live) {
  const cache = await caches.open(DATA);
  try {
    const res = await live();
    if (!res.ok) throw Object.assign(new Error(s().no_repo), { status: res.status });
    const buf = await res.arrayBuffer();
    await cache.put(saved(rel), new Response(buf));
    return buf;
  } catch (e) {
    if (e.status) throw e; // GitHub answered no: the saved copy would hide it
    const hit = await cache.match(saved(rel));
    if (!hit) throw new Error(s().offline);
    return hit.arrayBuffer();
  }
}
async function listing(c, dir) {
  try {
    return JSON.parse(new TextDecoder().decode(await cached(`list:${dir}`, () => gh(c, dir))));
  } catch (e) {
    // an empty folder is not a bad token: GitHub says 404 for both, so ask about the repository
    if (e.status === 404 && (await fetch(`${API}/repos/${c.repo}`, {
      headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store" })).ok) return [];
    throw e;
  }
}
async function days(c) {
  const names = (await listing(c, "home/edition")).map((f) => f.name);
  return names.map((n) => (n.match(/^(\d{4}-\d{2}-\d{2})\.json\.sealed$/) || [])[1]).filter(Boolean).sort();
}
async function sealed(c, rel, key = c.key, raw = false) {
  const buf = await cached(rel, () => gh(c, `${rel}.sealed`, true));
  return unseal(key, rel, buf, raw);
}
const frontRel = (day) => `home/edition/${day}.json`;
const pieceRel = (day, id) => `home/edition/${day}/${id}.json`;
const INDEX = "home/edition/index.json";
const BRIEF = "home/brief.json";
const recordRel = (device, wk) => `record/${device}/${wk}.jsonl`; // one file a week, so a write stays small (D76)

// keep the latest issue whole for offline reading, and nothing older (D37)
async function keep(c, page) {
  const ids = [...page.sections.flatMap((x) => x.pieces), ...page.saved].map((p) => p.id);
  for (const id of ids) await sealed(c, pieceRel(page.day, id)).catch(() => {});
  const cache = await caches.open(DATA);
  const mine = new Set(["list:home/edition", frontRel(page.day), INDEX, ...ids.map((id) => pieceRel(page.day, id))].map(saved));
  for (const req of await cache.keys()) if (!mine.has(req.url) && !req.url.includes("record")) await cache.delete(req);
}

// the record: this phone's, and what the reader's other devices wrote (D46)

let othersP = null;
function others(c) {
  othersP = othersP || (async () => {
    const out = [];
    for (const dir of await listing(c, "record").catch(() => [])) {
      if (dir.type !== "dir" || dir.name === c.device) continue;
      for (const f of await listing(c, `record/${dir.name}`).catch(() => [])) {
        const wk = (f.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl\.sealed$/) || [])[1];
        if (!wk) continue;
        const text = await sealed(c, recordRel(dir.name, wk), c.rkey, true).catch(() => "");
        for (const line of text.split("\n")) if (line.trim()) try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
      }
    }
    return out;
  })();
  return othersP;
}
let indexP = null, latest = null;
const index = (c) => (indexP = indexP || sealed(c, INDEX).catch(() => ({ steered: {}, pieces: {} })));
async function record(c) { return [...(await others(c)), ...own]; }

// writing back: this phone's weeks that changed, then the brief (D71)
async function write(c, rel, bytes, message) {
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  for (let tries = 0; tries < 3; tries++) {
    const meta = await gh(c, `${rel}.sealed`);
    const sha = meta.ok ? (await meta.json()).sha : undefined;
    const res = await gh(c, `${rel}.sealed`, false, { method: "PUT", body: JSON.stringify({ message, content: btoa(b64), sha }) });
    if (res.ok) return;
    if (res.status === 403 || res.status === 404) throw Object.assign(new Error(s().cant_write), { cantWrite: true });
    if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub ${res.status}`); // 409, 422: written meanwhile
  }
  throw new Error("GitHub kept moving"); // the week stays marked and goes next time
}
let syncing = null, morning = "5:07";
function sync() {
  if (!cfg || !cfg.rkey || syncing) return syncing;
  if (!dirty.size) return null;
  const c = cfg, weeks = [...dirty];
  again = new Set();
  syncing = (async () => {
    try {
      for (const w of weeks) {
        const rel = recordRel(c.device, w);
        const lines = own.filter((e) => week(e.t) === w).map((e) => JSON.stringify(e)).join("\n") + "\n";
        await write(c, rel, await seal(c.rkey, rel, lines), "Record");
      }
      const b = await brief(await index(c), await record(c), nextDay(morning));
      await write(c, BRIEF, await seal(c.key, BRIEF, JSON.stringify(b)), "Brief");
      weeks.forEach((w) => { if (!again.has(w)) dirty.delete(w); }); // a week stays marked until it is written
      cantWrite = false;
    } catch (e) {
      if (e.cantWrite) { cantWrite = true; document.querySelector("nav .note")?.removeAttribute("hidden"); }
      // offline or slow: it stays on the phone and goes with the next write
    } finally {
      again = null;
      syncing = null;
      await saveOwn();
    }
  })();
  return syncing;
}

// pages

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
function clean(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (DROP.has(el.tagName.toUpperCase())) { el.remove(); continue; }
      walk(el);
      if (!TAGS.has(el.tagName)) el.replaceWith(...el.childNodes); // keep the text, drop the element
      else for (const a of [...el.attributes]) el.removeAttribute(a.name);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
function short(page, day) {
  const [, m, d] = day.split("-").map(Number);
  const month = page.labels.months.split(" ")[m - 1];
  return page.lang === "hu" ? `${month} ${d}.` : `${d} ${month}`;
}
let stop = () => {}; // what the page on screen does when it goes
function show(title, body, nav = "") {
  stop();
  stop = () => {};
  document.title = title;
  document.documentElement.lang = lang;
  $main.innerHTML = body + nav;
  scrollTo(0, 0);
}
function navFor(page, list, kept = true) {
  const t = page.labels, i = list.indexOf(page.day);
  const prev = i > 0 ? `<a href="#${list[i - 1]}">← ${esc(short(page, list[i - 1]))}</a>` : "<span></span>";
  const next = i >= 0 && i + 1 < list.length ? `<a href="#${list[i + 1]}">${esc(short(page, list[i + 1]))} →</a>` : "<span></span>";
  return `<nav>${prev}<span class=links>${kept ? `<a href="#kept">${esc(t.kept)}</a>` : ""}<a href="#forget">${esc(s().forget)}</a></span>${next}` +
    `<span class="note"${cantWrite ? "" : " hidden"}>${esc(s().cant_write)}</span></nav>`;
}
function watchLooks(st) { // a headline on screen for LOOK_MS while the page is in front
  const timers = new Map(), done = new Set(Object.keys(st).filter((id) => st[id].looked));
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const id = en.target.dataset.id;
      clearTimeout(timers.get(id));
      if (!done.has(id) && en.isIntersecting && document.visibilityState === "visible")
        timers.set(id, setTimeout(() => { done.add(id); log({ ev: "look", id }); }, LOOK_MS));
    }
  }, { threshold: 0.6 });
  document.querySelectorAll("li[data-id]").forEach((li) => io.observe(li));
  return () => { io.disconnect(); timers.forEach(clearTimeout); };
}
function issue(page, list, idx, evs) {
  const t = page.labels, st = state(evs), every = marksEver(evs);
  for (const p of [...page.sections.flatMap((x) => x.pieces), ...page.saved]) if (!st[p.id]) log({ ev: "seen", id: p.id });
  const item = (p, lead) => `<li data-id="${esc(p.id)}"${finished(st[p.id], (idx.pieces[p.id] || {}).words) ? " class=done" : ""}>` +
    `<a href="#${page.day}/${esc(p.id)}">${esc(p.head)}</a>` + (lead && p.lead ? `<p>${esc(p.lead)}</p>` : "") + `<span>${esc(p.host)}</span></li>`;
  const parts = [];
  if (page.answers && page.answers.length) {
    const items = page.answers.map((a) => {
      const m = every[a.mark], src = m && idx.pieces[m.piece];
      return `<li class=answer>${m ? `<blockquote>${esc(m.text)}</blockquote>` : ""}<p>${esc(a.text)}</p>` +
        (src ? `<span><a href="#${src.day}/${esc(m.piece)}">${esc(src.head)}</a></span>` : "") + "</li>";
    });
    parts.push(`<section><h2>${esc(t.answers)}</h2><ol>${items.join("")}</ol></section>`);
  }
  parts.push(...page.sections.map((x) => `<section><h2>${esc(x.name)}</h2><ol>${x.pieces.map((p) => item(p, true)).join("")}</ol></section>`));
  if (page.saved.length) parts.push(`<section><h2>${esc(t.saved)}</h2><ol>${page.saved.map((p) => item(p, false)).join("")}</ol></section>`);
  if (!parts.length) parts.push(`<p class=empty>${esc(t.empty)}</p>`);
  show(page.dateline, `<h1>${esc(page.dateline)}</h1>${parts.join("")}`, navFor(page, list));
  document.querySelectorAll("li.answer blockquote").forEach((q) => q.addEventListener("click", () => q.classList.toggle("open")));
  stop = watchLooks(st);
}
function marksEver(evs) { // every mark ever made, deleted or not: an answer quotes its question
  const out = {};
  for (const e of evs) if (e.ev === "mark") out[e.id] = e;
  return out;
}
function keptPage(page, list, idx, evs) {
  const t = page.labels, st = state(evs);
  const mine = Object.entries(idx.pieces).filter(([id, p]) => kept(p, st[id])).sort(([a, p], [b, q]) => (p.day + a > q.day + b ? -1 : 1));
  const items = mine.map(([id, p]) => `<li><a href="#${p.day}/${esc(id)}">${esc(p.head)}</a><span>${esc(p.host)} · ${esc(short(page, p.day))}</span></li>`);
  show(t.kept, `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header><h1>${esc(t.kept)}</h1>` + (items.length ? `<ol>${items.join("")}</ol>` : `<p class=empty>${esc(t.nothing_kept)}</p>`),
    navFor({ ...page, day: "" }, list, false));
}

function reader(page, art, id, idx, evs) {
  const t = page.labels;
  if (!art.html) { log({ ev: "open", id, external: true }); sync(); location.replace(art.url); return; } // the site refused: read it there
  log({ ev: "open", id });
  const seq = [...page.sections.flatMap((x) => x.pieces), ...page.saved];
  const piece = seq.find((p) => p.id === id) || {};
  const nxt = seq[seq.indexOf(piece) + 1];
  const after = nxt ? `<a class=next href="#${page.day}/${esc(nxt.id)}"><span>${esc(t.next)}</span>${esc(nxt.head)}</a>`
    : `<a class=next href="#${page.day}/done">${esc(t.done)}</a>`;
  const st = state(evs)[id];
  const isKept = kept(piece, st);
  const line = why(idx, evs, id, t);
  const less = id in pressed(evs);
  const lessDone = fill(t.less_done, { topic: piece.topic });
  const whyP = line ? `<p class=why><span>${esc(less ? lessDone : line)}</span> <button class=quiet>${esc(less ? t.undo : t.less)}</button></p>` : "";
  const head = `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header>${whyP}` +
    `<h1 class=title>${esc(art.title)}</h1>` + (art.byline ? `<p class=byline>${esc(art.byline)}</p>` : "");
  const foot = `<footer><button id=keep data-kept="${isKept}">${esc(isKept ? t.keeping : t.keep)}</button>` +
    `<a href="${esc(art.url)}" rel="noreferrer">${esc(t.original)} ↗</a></footer>${after}`;
  show(art.title, head + `<article>${clean(art.html)}</article>`, foot);
  const article = document.querySelector("article");

  // "less of this", and back
  document.querySelector("p.why button")?.addEventListener("click", (ev) => {
    const on = id in pressed([...new Set([...evs, ...own])]);
    log({ ev: on ? "less_undo" : "less", id });
    ev.target.textContent = on ? t.less : t.undo;
    ev.target.previousElementSibling.textContent = on ? line : lessDone;
  });
  const keepB = document.getElementById("keep");
  keepB.addEventListener("click", () => {
    const now = keepB.dataset.kept !== "true";
    log({ ev: "keep", id, kept: now });
    keepB.dataset.kept = String(now);
    keepB.textContent = now ? t.keeping : t.keep;
  });

  // reading time and how far down: one read event a visit, updated as it goes
  let visit = null, last = Date.now(), active = Date.now();
  const measure = () => {
    const el = document.scrollingElement, top = article.offsetTop, end = top + article.offsetHeight;
    const progress = Math.min(1, Math.max(0, (el.scrollTop + innerHeight - top) / Math.max(1, end - top)));
    if (!visit && progress <= 0) return;
    visit = visit || log({ ev: "read", id, ms: 0, progress: 0 });
    visit.progress = Math.max(visit.progress, Math.round(progress * 1000) / 1000);
    touch(visit);
  };
  const tick = () => {
    const now = Date.now();
    if (document.visibilityState === "visible" && now - active < 60000) {
      visit = visit || log({ ev: "read", id, ms: 0, progress: 0 });
      visit.ms += now - last;
      touch(visit);
    }
    last = now;
  };
  const onAct = () => { tick(); active = Date.now(); measure(); };
  for (const ev of ["scroll", "keydown", "pointermove", "touchstart"]) addEventListener(ev, onAct, { passive: true });
  const beat = setInterval(() => { tick(); measure(); saveOwn(); }, BEAT);
  measure();

  // marks: a tap on a paragraph highlights it or asks about it; a mark is kept by its text
  const squash = (x) => x.replace(/\s+/g, " ").trim();
  const blocks = [...article.querySelectorAll(BLOCKS)].filter((b) => !b.querySelector(BLOCKS));
  const on = new Map();
  const paint = (block, m) => { block.classList.add("m-" + m.kind); on.set(block, [...(on.get(block) || []), m]); };
  for (const m of Object.values(marks(evs))) {
    if (m.piece !== id) continue;
    const whole = blocks.find((b) => squash(b.textContent) === m.text);
    if (whole) paint(whole, m);
  }
  const bar = document.createElement("div");
  bar.className = "bar"; bar.hidden = true; document.body.appendChild(bar);
  let picked = null;
  const pick = (b) => { picked?.classList.remove("picked"); picked = b; b?.classList.add("picked"); };
  const close = () => { bar.hidden = true; pick(null); };
  const open = (acts) => {
    bar.replaceChildren(...acts.map(([label, fn]) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { close(); fn(); });
      return b;
    }));
    bar.hidden = false;
  };
  article.addEventListener("click", (ev) => {
    if (!getSelection().isCollapsed) return;
    const block = ev.target.closest(BLOCKS);
    if (!block || !blocks.includes(block) || block === picked) return close();
    const text = squash(block.textContent).slice(0, 4000);
    if (text.length < 3) return close();
    pick(block);
    const has = on.get(block) || [];
    const acts = [["highlight", t.highlight], ["question", t.question]].filter(([k]) => !has.some((m) => m.kind === k))
      .map(([kind, label]) => [label, async () => paint(block, log({ ev: "mark", id: await markId(id, kind, text), piece: id, kind, text }))]);
    if (has.length) acts.push([t.remove, () => {
      has.forEach((m) => { log({ ev: "unmark", id: m.id }); block.classList.remove("m-" + m.kind); });
      on.delete(block);
    }]);
    open(acts);
  });
  const outside = (ev) => { if (!article.contains(ev.target) && !bar.contains(ev.target)) close(); };
  document.addEventListener("click", outside);

  stop = () => { // leaving the piece: what was read is saved, and written back (D71)
    tick(); measure();
    for (const ev of ["scroll", "keydown", "pointermove", "touchstart"]) removeEventListener(ev, onAct);
    document.removeEventListener("click", outside);
    clearInterval(beat);
    bar.remove();
    saveOwn();
    sync();
  };
}
function done(page, list) {
  show(page.labels.done, `<h1>${esc(page.dateline)}</h1><p class=end>${esc(page.labels.done)}</p>`, navFor(page, list));
}
function setup(error = "", was = {}) {
  const t = s();
  show("Paper", `<h1>Paper</h1><form id=setup>
    <label>${esc(t.repo)}<input name=repo value="${esc(was.repo)}" placeholder="owner/paper-data" autocomplete=off autocapitalize=off spellcheck=false required></label>
    <label>${esc(t.token)}<input name=token type=password value="${esc(was.token)}" autocomplete=off required></label>
    <label>${esc(t.code)}<input name=code autocomplete=off autocapitalize=characters spellcheck=false required></label>
    ${error ? `<p class=error>${esc(error)}</p>` : ""}<button>${esc(t.open)}</button></form>`);
  document.getElementById("setup").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      const code = f.get("code");
      const c = { repo: f.get("repo").trim(), token: f.get("token").trim(), key: await runKey(code),
        rkey: await deriveKey(code, "record v1"),
        device: (cfg && cfg.device) || [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("") };
      const res = await gh(c, "home/sections.md.sealed", true); // every paper has one: a wrong code fails here
      if (!res.ok) throw new Error(t.no_repo);
      await unseal(c.key, "home/sections.md", await res.arrayBuffer(), true);
      await put("cfg", c);
      cfg = c;
      othersP = indexP = null;
      route();
      sync();
    } catch (e) {
      setup(e.message, { repo: f.get("repo"), token: f.get("token") }); // the code is typed again
    }
  });
}

async function route() {
  const where = decodeURIComponent(location.hash.slice(1));
  if (where === "forget") {
    if (confirm(s().forget + "?")) { await sync(); await forget(); cfg = null; own = []; location.hash = ""; return setup(); }
    return history.back();
  }
  if (!cfg) return setup();
  if (!cfg.rkey) return setup(s().again, { repo: cfg.repo }); // a step 2 phone: the record key is new
  try {
    const list = await days(cfg);
    if (!list.length) return show("Paper", `<p class=empty>${esc(s().no_issue)}</p>`);
    if (list.at(-1) !== latest) { latest = list.at(-1); othersP = indexP = null; } // a new issue: a new index, and what the other devices did since
    const [day, id] = where.split("/");
    const want = list.includes(day) ? day : list.at(-1);
    const [page, idx, evs] = await Promise.all([sealed(cfg, frontRel(want)), index(cfg), record(cfg)]);
    lang = page.lang in SETUP ? page.lang : lang;
    morning = page.morning || morning;
    if (day === "kept") return keptPage(page, list, idx, evs);
    if (id === "done") return done(page, list);
    if (id) {
      const p = [...page.sections.flatMap((x) => x.pieces), ...page.saved].find((x) => x.id === id) || idx.pieces[id];
      // past KEEP_DAYS, or never fetched offline: the piece's text is gone, so read it at its outlet
      const art = await sealed(cfg, pieceRel(want, id)).catch((e) => { if (p && e.status === 404) return { url: p.url }; throw e; });
      return reader(page, art, id, idx, evs);
    }
    issue(page, list, idx, evs);
    if (want === list.at(-1)) keep(cfg, page);
  } catch (e) {
    if (e.wrongKey || e.status === 401) return setup(e.message, { repo: cfg.repo }); // a new token or code
    show("Paper", `<p class=empty>${esc(e.message)}</p>`);
  }
}

addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { saveOwn(); sync(); } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
Promise.all([get("cfg"), get("events"), get("dirty")]).then(([c, evs, d]) => {
  cfg = c || null; own = evs || []; dirty = new Set(d || []);
  route(); sync();
}, () => route());
