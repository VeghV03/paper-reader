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
const monthRel = (month) => `home/edition/months/${month}.json`;
const THREADS = "home/threads.jsonl";
const BRIEF = "home/brief.json";
const recordRel = (device, wk) => `record/${device}/${wk}.jsonl`; // one file a week, so a write stays small (D76)

// keep the latest issue whole for offline reading, and nothing older (D37)
async function keep(c, page) {
  const ids = [...page.sections.flatMap((x) => x.pieces), ...page.saved].map((p) => p.id);
  for (const id of ids) await sealed(c, pieceRel(page.day, id)).catch(() => {});
  const cache = await caches.open(DATA);
  const mine = new Set(["list:home/edition", frontRel(page.day), INDEX, ...ids.map((id) => pieceRel(page.day, id))].map(saved));
  for (const req of await cache.keys()) if (!mine.has(req.url) && !/record|\/months\/|threads/.test(req.url)) await cache.delete(req);
}

// the record: this phone's, and what the reader's other devices wrote (D46)

let othersP = null;
function others(c) {
  othersP = othersP || (async () => {
    const out = [];
    for (const dir of await listing(c, "record")) {
      if (dir.type !== "dir" || dir.name === c.device) continue;
      for (const f of await listing(c, `record/${dir.name}`)) {
        const wk = (f.name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl\.sealed$/) || [])[1];
        if (!wk) continue;
        const text = await sealed(c, recordRel(dir.name, wk), c.rkey, true);
        for (const line of text.split("\n")) if (line.trim()) try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
      }
    }
    return out;
  })().catch((e) => { othersP = null; throw e; });
  return othersP;
}
let indexP = null, threadsP = null, latest = null;
// the edition's lists: the small index, then a file a month of pieces and cards (D84)
const none = (empty) => (e) => { if (e.status === 404) return empty; throw e; }; // only a missing file is nothing
const index = (c) => (indexP = indexP || (async () => {
  const small = await sealed(c, INDEX).catch(none({ steered: {}, months: [] }));
  if (small.pieces) return { cards: {}, games: {}, ...small }; // an edition from before D84
  const out = { steered: small.steered || {}, pieces: {}, cards: {}, games: {} };
  for (const m of await Promise.all((small.months || []).map((month) => sealed(c, monthRel(month))))) {
    Object.assign(out.pieces, m.pieces || {});
    Object.assign(out.cards, m.cards || {});
    Object.assign(out.games, m.games || {});
  }
  return out;
})().catch((e) => { indexP = null; throw e; }));
// the running stories the run keeps; none until it writes one
const threads = (c) => (threadsP = threadsP || sealed(c, THREADS, c.key, true).then((text) => text.split("\n")
  .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((th) => th && th.id && Array.isArray(th.entries)), none([])).catch((e) => { threadsP = null; throw e; }));
async function record(c) { return [...(await others(c)), ...own]; }

// writing back: this phone's weeks that changed, then the brief (D71)
async function write(c, rel, bytes, message) {
  let b64 = "";
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  for (let tries = 0; tries < 3; tries++) {
    const meta = await gh(c, `${rel}.sealed`);
    const sha = meta.ok ? (await meta.json()).sha : undefined;
    const res = await gh(c, `${rel}.sealed`, false, { method: "PUT", body: JSON.stringify({ message, content: btoa(b64), sha }) });
    if (res.ok) { await (await caches.open(DATA)).put(saved(rel), new Response(bytes)); return; }
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
      const b = await brief(await index(c), await record(c), nextDay(morning), await threads(c));
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
  const links = (kept && t.kept ? `<a href="#kept">${esc(t.kept)}</a>` : "") +
    (t.settings ? `<a href="#settings">${esc(t.settings)}</a>` : `<a href="#forget">${esc(s().forget)}</a>`); // Forget sits in Settings
  return `<nav>${prev}<span class=links>${links}</span>${next}` +
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
function issue(page, list, idx, evs, ths = []) {
  const t = page.labels, st = state(evs), every = marksEver(evs);
  const all = [...page.sections.flatMap((x) => x.pieces), ...page.saved];
  for (const p of all) if (!st[p.id]) log({ ev: "seen", id: p.id });
  const stories = t.since ? moved(idx, evs, ths, page.day, all.map((p) => p.id)) : [];
  for (const m of stories) if (!m.piece && !st[m.thread.id]) log({ ev: "seen", id: m.thread.id });
  const first = new Set(stories.map((m) => m.piece).filter(Boolean));
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
  if (stories.length) {
    const items = stories.map((m) => m.piece ? item(all.find((p) => p.id === m.piece), true)
      : `<li data-id="${esc(m.thread.id)}"><a href="#${page.day}/${esc(m.thread.id)}">${esc(m.thread.title)}</a><p>${esc(m.new[0].text)}</p></li>`);
    parts.push(`<section><h2 class=since>${esc(t.since)}</h2><ol>${items.join("")}</ol></section>`);
  }
  parts.push(...page.sections.map((x) => [x.name, x.pieces.filter((p) => !first.has(p.id))]).filter(([, ps]) => ps.length)
    .map(([name, ps]) => `<section><h2>${esc(name)}</h2><ol>${ps.map((p) => item(p, true)).join("")}</ol></section>`));
  if (page.saved.length) parts.push(`<section><h2>${esc(t.saved)}</h2><ol>${page.saved.map((p) => item(p, false)).join("")}</ol></section>`);
  if (!parts.length) parts.push(`<p class=empty>${esc(t.empty)}</p>`);
  const saveP = t.save_link ? `<p class=save><button class=quiet id=save>${esc(t.save_link)}</button><span class=err></span></p>` : "";
  show(page.dateline, `<h1>${esc(page.dateline)}</h1>${parts.join("")}${crosswordLink(page)}${saveP}`, navFor(page, list));
  document.getElementById("save")?.addEventListener("click", (ev) => saveLink(page, ev.target));
  document.querySelectorAll("li.answer blockquote").forEach((q) => q.addEventListener("click", () => q.classList.toggle("open")));
  stop = watchLooks(st);
}
// Save a link (D86): the link on the clipboard, in a file of its own that the run folds into inbox.md
async function saveLink(page, button) {
  const err = button.nextElementSibling, c = cfg;
  err.textContent = "";
  button.disabled = true;
  try {
    const url = savedLink(await navigator.clipboard.readText());
    const rel = `home/saved/${new Date().toISOString().replace(/[:.]/g, "-")}-${c.device}.txt`;
    await write(c, rel, await seal(c.key, rel, url + "\n"), "Saved link");
    err.textContent = `${page.labels.saved}: ${url}`;
  } catch (e) {
    err.textContent = e.errors ? e.errors.join(" · ") : e.message;
  } finally {
    button.disabled = false;
  }
}
function updates(page, fresh, old) {
  const li = (x) => `<li><span>${esc(short(page, x.day))}</span>${esc(x.text)}</li>`;
  return (fresh.length ? `<ol class=updates>${fresh.map(li).join("")}</ol>` : "") + (old.length
    ? `<details class=earlier${fresh.length ? "" : " open"}><summary>${esc(page.labels.earlier)}</summary><ol class=updates>${old.map(li).join("")}</ol></details>` : "");
}
function caughtUp(evs, th, left, fresh, upto, piece) {
  if (!fresh.length || evs.concat(own).some((e) => e.ev === "since" && e.id === th.id && e.upto === upto)) return;
  const gap = left ? Math.round((startOf(upto) - startOf(left)) / DAY_MS) : null;
  log({ ev: "since", id: th.id, entries: fresh.length, upto, gap, ...(piece ? { piece } : {}) });
}
function storyPage(page, th, evs, idx) { // a story that moved without a piece in the issue
  const left = leftOff(idx, evs, th, page.day);
  const mine = [...th.entries].reverse().filter((x) => x.day <= page.day);
  const fresh = left ? mine.filter((x) => left < x.day) : mine.slice(0, 3);
  caughtUp(evs, th, left, fresh, page.day);
  show(th.title, `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header><h1 class=title>${esc(th.title)}</h1>` +
    `<div class=story>${updates(page, fresh, mine.filter((x) => !fresh.includes(x)))}</div>`);
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

// Settings, as the Mac's (D87): each part saves when it changes, checked first (settings.js), sealed
// with the run key, and read by the next morning's run
async function settingsPage(page, list, idx, evs) {
  const t = page.labels, c = cfg;
  // Forget this phone first: it stays within reach when the files cannot be read
  show(t.settings, `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header><h1>${esc(t.settings)}</h1><div id=settings></div>` +
    `<section><p><a href="#forget">${esc(s().forget)}</a></p></section>`, navFor({ ...page, day: "" }, list, true));
  const root = document.getElementById("settings");
  const text = (name) => sealed(c, `home/${name}`, c.key, true).catch(none(""));
  let secT, intT, feedT, outT, papT;
  try {
    [secT, intT, feedT, outT, papT] = await Promise.all(["sections.md", "interests.md", "feeds.yaml", "outlets.json", "paper.yaml"].map(text));
  } catch (e) {
    if (e.wrongKey || e.status === 401) throw e; // a new token or code: route asks for it
    root.innerHTML = `<p class=empty>${esc(e.message)}</p>`;
    return;
  }
  let feedText = feedT, outlets = [], paperText = papT;
  try { outlets = JSON.parse(outT || "[]"); } catch { /* shown empty, and not saved over */ }
  const el = (tag, attrs = {}, ...kids) => {
    const x = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k.startsWith("on") ? x.addEventListener(k.slice(2), v) : x.setAttribute(k, v);
    x.append(...kids); return x;
  };
  let queue = Promise.resolve(); // one write at a time
  const save = (name, make, err) => {
    let body;
    try { body = make(); } catch (e) { err.textContent = e.errors ? e.errors.join(" · ") : e.message; return Promise.resolve(false); }
    const rel = `home/${name}`;
    queue = queue.then(async () => {
      try { await write(c, rel, await seal(c.key, rel, body), "Settings"); err.textContent = ""; return true; }
      catch (e) { err.textContent = e.message; return false; }
    });
    return queue;
  };
  const block = (title, ...kids) => el("section", {}, el("h2", {}, title), ...kids);
  const fit = (a) => { a.style.height = "auto"; a.style.height = a.scrollHeight + "px"; };
  const grow = (a, value) => { // a line of text that wraps instead of running off the screen; Return ends it
    a.value = value || "";
    a.addEventListener("input", () => { if (a.value.includes("\n")) a.value = a.value.replace(/\s*\n\s*/g, " "); fit(a); });
    a.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); a.blur(); } });
    requestAnimationFrame(() => fit(a));
    return a;
  };

  const sections = () => {
    const err = el("p", { class: "err" }), rows = el("div", { class: "rows" });
    const now = () => [...rows.children].map((r) => Object.fromEntries([...r.querySelectorAll("[name]")].map((i) => [i.name, i.value])));
    const commit = () => save("sections.md", () => writeSections(now()), err);
    const row = (x) => {
      const r = el("div", { class: "row sec" },
        el("input", { name: "name", value: x.name, placeholder: t.name, onchange: commit }),
        el("button", { class: "quiet", "aria-label": "↑", onclick: () => { if (r.previousElementSibling) { rows.insertBefore(r, r.previousElementSibling); commit(); } } }, "↑"),
        el("button", { class: "quiet", "aria-label": t.remove, onclick: () => { r.remove(); commit(); } }, "×"),
        grow(el("textarea", { name: "what", rows: 1, placeholder: t.what, onchange: commit }), x.what),
        grow(el("textarea", { name: "topics", rows: 1, placeholder: t.topics, onchange: commit }), x.topics));
      return r;
    };
    readSections(secT).forEach((x) => rows.append(row(x)));
    const add = el("button", { class: "quiet", onclick: () => { const r = row({ name: "", what: "", topics: "" }); rows.append(r); r.querySelector("input").focus(); } }, t.add);
    return block(t.sections, rows, add, err);
  };

  const less = () => { // the topics asked for less of, and back (learn.js)
    const names = Object.fromEntries(readSections(secT).map((x) => [sectionId(x.name), x.name]));
    const items = Object.entries(pressed(evs.concat(own))).filter(([id]) => idx.pieces[id]).sort((a, b) => b[1] - a[1]);
    if (!items.length || !t.less) return null;
    return block(t.less, ...items.map(([id, when]) => {
      const p = idx.pieces[id];
      const r = el("div", { class: "row link" }, el("span", {}, `${p.topic} · ${names[p.section] || ""} · ${iso(new Date(when))}`),
        el("button", { class: "quiet", onclick: () => {
          log({ ev: "less_undo", id }); saveOwn();
          const sec = r.closest("section"); r.remove();
          if (!sec.querySelector(".row")) sec.remove();
        } }, t.undo));
      return r;
    }));
  };

  const interests = () => {
    const err = el("p", { class: "err" });
    let timer;
    const area = el("textarea", { rows: 8, oninput: () => { clearTimeout(timer); timer = setTimeout(() => save("interests.md", () => writeInterests(area.value), err), 600); } });
    area.value = intT;
    return block(t.interests, area, err);
  };

  const feeds = () => { // a feed's line goes or comes; every other line stays (D88)
    const err = el("p", { class: "err" }), rows = el("div", { class: "rows" });
    const draw = () => {
      const { feeds: fs, editable } = readFeeds(feedText);
      rows.replaceChildren(...fs.map((f) => el("div", { class: "row link" }, el("span", {}, f.name || f.url),
        ...(editable ? [el("button", { class: "quiet", "aria-label": t.remove, onclick: async () => {
          const next = removeFeed(feedText, f.url);
          if (await save("feeds.yaml", () => next, err)) { feedText = next; draw(); }
        } }, "×")] : []))));
      adder.hidden = !editable;
    };
    const name = el("input", { placeholder: t.name }), url = el("input", { type: "url", placeholder: t.url });
    const adder = el("div", { class: "row feed" }, name, url, el("button", { class: "quiet", onclick: async () => {
      let next;
      if (await save("feeds.yaml", () => (next = addFeed(feedText, name.value, url.value)), err)) { feedText = next; name.value = url.value = ""; draw(); }
    } }, "+"));
    draw();
    return block(t.feeds, rows, adder, err);
  };

  const outletsB = () => {
    const err = el("p", { class: "err" }), chips = el("div", { class: "chips" });
    const draw = () => chips.replaceChildren(...newsrooms(outlets).map((o) => el("span", { class: "chip" }, o.org,
      el("button", { class: "quiet", "aria-label": t.remove, onclick: async () => {
        const keep = newsrooms(outlets).filter((x) => x.org !== o.org).flatMap((x) => x.ids);
        if (await save("outlets.json", () => writeOutlets(outlets, keep), err)) { outlets = outlets.filter((x) => keep.includes(x.id)); draw(); }
      } }, "×"))));
    draw();
    return block(t.outlets, chips, err);
  };

  const language = () => { // the page's own words change with the next issue
    const err = el("p", { class: "err" }), row = el("div", { class: "choice" });
    for (const [code, name] of [["en", "English"], ["hu", "Magyar"]]) {
      row.append(el("button", { "aria-pressed": String(readLanguage(paperText) === code), onclick: async (ev) => {
        let next;
        if (await save("paper.yaml", () => (next = writeLanguage(paperText, code)), err)) {
          paperText = next;
          row.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === ev.target)));
        }
      } }, name));
    }
    return block(t.language, row, err);
  };

  root.append(...[sections(), less(), interests(), feeds(), outletsB(), language()].filter(Boolean));
  stop = () => sync();
}

function reader(page, art, id, idx, evs, ths = []) {
  const t = page.labels;
  if (!art.html) { log({ ev: "open", id, external: true }); sync(); location.replace(art.url); return; } // the site refused: read it there
  log({ ev: "open", id });
  const listed = [...page.sections.flatMap((x) => x.pieces), ...page.saved];
  const lifted = t.since ? moved(idx, evs, ths, page.day, listed.map((p) => p.id)).map((m) => m.piece).filter(Boolean) : [];
  const seq = [...listed.filter((p) => lifted.includes(p.id)), ...listed.filter((p) => !lifted.includes(p.id))];
  const piece = seq.find((p) => p.id === id) || {};
  const nxt = seq[seq.indexOf(piece) + 1];
  const after = nxt ? `<a class=next href="#${page.day}/${esc(nxt.id)}"><span>${esc(t.next)}</span>${esc(nxt.head)}</a>`
    : `<a class=next href="#${page.day}/done">${esc(t.done)}</a>`;
  const st = state(evs)[id];
  const isKept = kept(piece, st);
  const line = why(idx, evs, id, t);
  const less = id in pressed(evs);
  const lessDone = fill(t.less_done, { topic: piece.topic });
  const whyP = line && t.less ? `<p class=why><span>${esc(less ? lessDone : line)}</span> <button class=quiet>${esc(less ? t.undo : t.less)}</button></p>` : "";
  // a prediction or a link is asked before the piece: the article waits for a pick or a skip
  const game = t.skip && (page.games || []).find((g) => g.piece === id);
  const answered = game && played(evs.concat(own))[game.id];
  let asking = !!game && !answered;
  const link = game && game.kind === "link";
  const th = t.earlier && ths.find((x) => x.id === (idx.pieces[id] || {}).thread);
  const told = th && story(idx, evs, th, id, page.day);
  let storyP = "";
  const held = asking && link; // a link's story follows the answer
  const catchUp = () => caughtUp(evs, th, told.left, told.left ? told.new : [], page.day, id);
  if (told && (told.new.length || told.old.length)) {
    if (!held) catchUp();
    storyP = `<details class=thread${told.new.length ? " open" : ""}${held ? " hidden" : ""}><summary>${esc(th.title)}</summary>${updates(page, told.new, told.old)}</details>`;
  }
  const box = game ? "<div id=game></div>" : "";
  // an outlet's title often states the finding: a prediction shows the paper's headline until answered
  const hidden = asking && !link;
  const head = `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header>${link ? box : ""}${whyP}${storyP}` +
    `<h1 class=title>${esc(hidden ? piece.head || art.title : art.title)}</h1>` + (art.byline ? `<p class=byline>${esc(art.byline)}</p>` : "") + (link ? "" : box);
  const foot = `<footer>${t.keep ? `<button id=keep data-kept="${isKept}">${esc(isKept ? t.keeping : t.keep)}</button>` : "<span></span>"}` +
    `<a href="${esc(art.url)}" rel="noreferrer">${esc(t.original)} ↗</a></footer>${after}`;
  show(hidden ? piece.head || art.title : art.title, head + `<article${asking ? " hidden" : ""}>${clean(art.html)}</article><div id=reveal></div><div id=card></div>`, foot);
  const article = document.querySelector("article");

  // "less of this", and back
  document.querySelector("p.why button")?.addEventListener("click", (ev) => {
    const on = id in pressed([...new Set([...evs, ...own])]);
    log({ ev: on ? "less_undo" : "less", id });
    ev.target.textContent = on ? t.less : t.undo;
    ev.target.previousElementSibling.textContent = on ? line : lessDone;
  });
  const keepB = document.getElementById("keep");
  keepB?.addEventListener("click", () => {
    const now = keepB.dataset.kept !== "true";
    log({ ev: "keep", id, kept: now });
    keepB.dataset.kept = String(now);
    keepB.textContent = now ? t.keeping : t.keep;
  });

  // reading time and how far down: one read event a visit, updated as it goes
  let visit = null, last = Date.now(), active = Date.now();
  const measure = () => {
    if (asking) return; // reading counts once the article is out
    const el = document.scrollingElement, top = article.offsetTop, end = top + article.offsetHeight;
    const progress = Math.min(1, Math.max(0, (el.scrollTop + innerHeight - top) / Math.max(1, end - top)));
    if (!visit && progress <= 0) return;
    visit = visit || log({ ev: "read", id, ms: 0, progress: 0 });
    visit.progress = Math.max(visit.progress, Math.round(progress * 1000) / 1000);
    touch(visit);
  };
  const tick = () => {
    if (asking) return;
    const now = Date.now();
    if (document.visibilityState === "visible" && now - active < 60000) {
      visit = visit || log({ ev: "read", id, ms: 0, progress: 0 });
      visit.ms += now - last;
      touch(visit);
    }
    last = now;
  };
  // finished (as learn.js counts it, with the time of earlier visits): one due card below (D81)
  const had = st ? st.ms : 0, before = st ? st.progress : 0, words = (idx.pieces[id] || {}).words;
  let asked = !t.show;
  const finishedNow = () => {
    if (asked || !visit || Math.max(before, visit.progress) < FINISHED || had + visit.ms < ((words || 0) / WPM) * 60000 / 3) return;
    asked = true;
    record(cfg).catch(() => [...own]).then((all) => showCard(t, due(idx.cards, all, id, Date.now(), idx.games)));
  };
  const onAct = () => { tick(); active = Date.now(); measure(); finishedNow(); };
  for (const ev of ["scroll", "keydown", "pointermove", "touchstart"]) addEventListener(ev, onAct, { passive: true });
  const beat = setInterval(() => { tick(); measure(); saveOwn(); }, BEAT);
  measure();

  if (game) {
    const gbox = document.getElementById("game"), reveal = document.getElementById("reveal");
    const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
    const result = (pick) => { // a link answers at once, above; a prediction at the end
      const opts = el("div", "options"), out = el("div", "card");
      game.options.forEach((o, i) => {
        const b = el("button", i === game.answer ? "right" : i === pick ? "wrong" : "", o);
        b.disabled = true; opts.append(b);
      });
      out.append(el("p", "front", game.prompt), opts);
      (link ? gbox : reveal).replaceChildren(out);
    };
    if (!asking) { if (!link) result(answered.pick); }
    else {
      const opts = el("div", "options"), skip = el("button", "quiet", t.skip), q = el("div", "card");
      const settle = (pick) => { // the first answer counts, checked here against the edition's answer
        [...opts.children, skip].forEach((b) => { b.disabled = true; });
        log(pick == null ? { ev: "game", id: game.id, skipped: true } : { ev: "game", id: game.id, pick, right: pick === game.answer });
        saveOwn();
        asking = false;
        gbox.replaceChildren();
        article.hidden = false; article.classList.add("late");
        document.querySelector("h1.title").textContent = art.title;
        document.title = art.title;
        const thread = document.querySelector("details.thread");
        if (thread && held) { thread.hidden = false; thread.open = true; catchUp(); }
        last = active = Date.now(); measure();
        result(pick);
      };
      game.options.forEach((o, i) => {
        const b = el("button", "", o);
        b.addEventListener("click", () => settle(i), { once: true });
        opts.append(b);
      });
      skip.addEventListener("click", () => settle(null), { once: true });
      q.append(el("p", "front", game.prompt), opts, skip);
      gbox.replaceChildren(q);
    }
  }

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
    if (!getSelection().isCollapsed || !t.highlight) return;
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
function showCard(t, c) {
  const box = document.getElementById("card");
  if (!c || !box) return;
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const rate = (r) => { log({ ev: "review", id: c.id, rating: r }); saveOwn(); };
  box.className = "card";
  if (c.card === "flip") {
    const row = el("div", "row"), reveal = el("button", "", t.show);
    reveal.addEventListener("click", () => {
      const again = el("button", "", t.again), good = el("button", "", t.good);
      for (const [b, r] of [[again, "again"], [good, "good"]])
        b.addEventListener("click", () => { rate(r); row.replaceChildren(el("span", "rated", b.textContent)); });
      box.insertBefore(el("p", "back", c.back), row);
      row.replaceChildren(again, good);
    });
    row.append(reveal);
    box.replaceChildren(el("p", "front", c.front), row);
  } else {
    const opts = el("div", "options");
    (c.options || []).forEach((o, i) => {
      const b = el("button", "", o);
      b.addEventListener("click", () => {
        rate(i === c.answer ? "good" : "again");
        [...opts.children].forEach((x, j) => { x.disabled = true; if (j === c.answer) x.classList.add("right"); else if (j === i) x.classList.add("wrong"); });
      }, { once: true });
      opts.append(b);
    });
    box.replaceChildren(el("p", "front", c.prompt), opts);
  }
}
const crosswordLink = (page) => (page.crossword && page.labels.crossword
  ? `<a class=next href="#${page.day}/crossword">${esc(page.labels.crossword)}</a>` : "");
function done(page, list) {
  show(page.labels.done, `<h1>${esc(page.dateline)}</h1><p class=end>${esc(page.labels.done)}</p>${crosswordLink(page)}`, navFor(page, list));
}
// Sunday's crossword, as the Mac's: the grid comes laid out in the edition; letters typed stay on
// this phone, and each word solved goes into the record (D82)
function crosswordPage(page, idx, evs) {
  const t = page.labels, { id, rows, cols } = page.crossword;
  const solvedBefore = new Set((played(evs.concat(own))[id] || {}).solved || []);
  const entries = page.crossword.entries.map((x) => ({ ...x, solved: solvedBefore.has(x.i) }));
  const lists = [false, true].map((down) => {
    const items = entries.filter((x) => x.down === down).map((x) => {
      const p = idx.pieces[x.piece];
      return `<li data-i="${x.i}"${x.solved ? " class=done" : ""}><p><b>${x.num}</b> ${esc(x.clue)}</p>` +
        (p ? `<span><a href="#${p.day}/${esc(x.piece)}">${esc(p.head)}</a></span>` : "") + "</li>";
    });
    return items.length ? `<section><h2>${esc(t[down ? "down" : "across"])}</h2><ol>${items.join("")}</ol></section>` : "";
  });
  show(t.crossword, `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header><h1>${esc(t.crossword)}</h1>` +
    `<div class=grid id=grid><input id=type autocapitalize=characters autocomplete=off autocorrect=off spellcheck=false aria-label="${esc(t.crossword)}"></div>` +
    `<div id=clues>${lists.join("")}</div><div class=clue id=clue hidden></div>`);
  const grid = document.getElementById("grid"), input = document.getElementById("type"), bar = document.getElementById("clue");
  const key = "crossword:" + id, cells = new Map(); // "r,c" -> {el, letter, across, down}
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch { saved = {}; }
  const keepLetters = () => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* private mode */ } };
  grid.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
  grid.style.setProperty("--cell", `min(40px, calc((100vw - 40px - ${cols - 1} * 3px) / ${cols}))`);
  const at = (x, k) => [x.row + (x.down ? k : 0), x.col + (x.down ? 0 : k)].join();
  entries.forEach((x, n) => {
    for (let k = 0; k < x.answer.length; k++) {
      const c = cells.get(at(x, k)) || { letter: "" };
      c[x.down ? "down" : "across"] = n;
      cells.set(at(x, k), c);
    }
  });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = cells.get([r, c].join()), d = document.createElement("div");
    if (cell) {
      d.className = "cell"; cell.el = d; d.dataset.at = [r, c].join();
      const num = entries.find((x) => x.row === r && x.col === c);
      if (num) d.append(Object.assign(document.createElement("small"), { textContent: num.num }));
      d.append(document.createElement("span"));
    }
    grid.insertBefore(d, input);
  }
  const letters = (x) => [...x.answer].map((_, k) => cells.get(at(x, k)));
  const set = (c, ch) => { c.letter = ch; c.el.lastChild.textContent = ch; };
  const locked = (c) => [c.across, c.down].some((n) => n != null && entries[n].solved);
  const solve = (n) => {
    entries[n].solved = true;
    letters(entries[n]).forEach((c, k) => { set(c, entries[n].answer[k]); c.el.classList.add("solved"); });
    document.querySelector(`#clues li[data-i="${entries[n].i}"]`)?.classList.add("done");
  };
  entries.forEach((x, n) => { if (x.solved) solve(n); });
  for (const [where, ch] of Object.entries(saved)) { const c = cells.get(where); if (c && !c.letter) set(c, ch); }

  let cur = null, dir = "across";
  const entry = () => { const c = cells.get(cur); return c[dir] ?? c[dir === "across" ? "down" : "across"]; };
  const pin = () => { // the clue sits on the keyboard
    const vv = window.visualViewport;
    bar.style.bottom = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) + "px" : "0";
  };
  window.visualViewport?.addEventListener("resize", pin);
  window.visualViewport?.addEventListener("scroll", pin);
  const draw = () => {
    for (const c of cells.values()) c.el.classList.remove("on", "at");
    document.querySelectorAll("#clues li.on").forEach((li) => li.classList.remove("on"));
    if (!cur) return;
    const n = entry(), x = entries[n];
    dir = x.down ? "down" : "across";
    letters(x).forEach((c) => c.el.classList.add("on"));
    cells.get(cur).el.classList.add("at");
    document.querySelector(`#clues li[data-i="${x.i}"]`)?.classList.add("on");
    bar.replaceChildren(Object.assign(document.createElement("b"), { textContent: x.num }), x.clue);
    bar.hidden = false; pin();
    const el = cells.get(cur).el;
    input.style.left = el.offsetLeft + "px"; input.style.top = el.offsetTop + "px";
  };
  const focus = () => { input.value = " "; input.focus({ preventScroll: true }); input.setSelectionRange(1, 1); };
  const go = (where, d) => { cur = where; if (d) dir = d; draw(); focus(); };
  grid.addEventListener("click", (ev) => {
    const d = ev.target.closest(".cell");
    if (!d) return;
    const c = cells.get(d.dataset.at);
    if (d.dataset.at === cur && c.across != null && c.down != null) dir = dir === "across" ? "down" : "across";
    else if (c[dir] == null) dir = dir === "across" ? "down" : "across";
    go(d.dataset.at);
  });
  document.getElementById("clues").addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-i]");
    if (!li || ev.target.closest("a")) return;
    const x = entries.find((e) => String(e.i) === li.dataset.i), cs = letters(x);
    const k = Math.max(0, cs.findIndex((c) => !c.letter));
    go(at(x, k), x.down ? "down" : "across");
  });
  const step = (by) => {
    const x = entries[entry()], k = letters(x).findIndex((c) => c === cells.get(cur)) + by;
    if (k >= 0 && k < x.answer.length) { cur = at(x, k); draw(); }
  };
  const check = () => { // a word solved is checked here, against the edition's answer
    const c = cells.get(cur);
    for (const n of [c.across, c.down]) {
      if (n == null || entries[n].solved) continue;
      if (letters(entries[n]).map((x) => x.letter).join("") !== entries[n].answer) continue;
      solve(n);
      log({ ev: "game", id, entry: entries[n].i });
      saveOwn();
    }
  };
  const type = (ch) => {
    const c = cells.get(cur);
    if (!locked(c)) { set(c, ch); saved[cur] = ch; keepLetters(); check(); }
    step(1);
  };
  const erase = () => {
    const c = cells.get(cur);
    if (!c.letter || locked(c)) step(-1);
    const d = cells.get(cur);
    if (!locked(d)) { set(d, ""); delete saved[cur]; keepLetters(); }
  };
  input.addEventListener("input", (ev) => {
    if (ev.isComposing || !cur) return;
    const v = input.value; // a keyboard sends a letter at a time; a paste or a suggestion sends several
    if (!v) erase();
    else for (const ch of v.normalize("NFC").replace(/^ /, "")) if (/\p{L}/u.test(ch)) type(ch.toLocaleUpperCase());
    focus();
  });
  input.addEventListener("compositionend", () => { input.dispatchEvent(new Event("input")); });
  input.addEventListener("keydown", (ev) => {
    const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (!moves[ev.key] || !cur) return;
    ev.preventDefault();
    const [r, c] = cur.split(",").map(Number), [dr, dc] = moves[ev.key], next = [r + dr, c + dc].join();
    if (cells.has(next)) go(next, dr ? "down" : "across");
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) { cur = null; draw(); bar.hidden = true; }
  }, 100));
  stop = () => {
    window.visualViewport?.removeEventListener("resize", pin);
    window.visualViewport?.removeEventListener("scroll", pin);
    saveOwn(); sync();
  };
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
      othersP = indexP = threadsP = null;
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
    if (list.at(-1) !== latest) { latest = list.at(-1); othersP = indexP = threadsP = null; } // a new issue: a new index, and what the other devices did since
    const [day, id] = where.split("/");
    const want = list.includes(day) ? day : list.at(-1);
    const [page, newest, idx, evs, ths] = await Promise.all([sealed(cfg, frontRel(want)),
      want === list.at(-1) ? null : sealed(cfg, frontRel(list.at(-1))).catch(() => null), // reading goes on when a list cannot be read; only the brief needs them whole (sync)
      index(cfg).catch(() => ({ steered: {}, pieces: {}, cards: {}, games: {} })), record(cfg).catch(() => [...own]), threads(cfg).catch(() => [])]);
    if (newest && newest.lang === page.lang) page.labels = { ...page.labels, ...newest.labels }; // the page's words are the newest edition's
    lang = page.lang in SETUP ? page.lang : lang;
    morning = page.morning || morning;
    if (day === "kept") return keptPage(page, list, idx, evs);
    if (day === "settings" && page.labels.settings) return await settingsPage(page, list, idx, evs);
    if (id === "done") return done(page, list);
    if (id === "crossword" && page.crossword && page.labels.crossword) return crosswordPage(page, idx, evs);
    if (id && id.startsWith("t-")) {
      const th = ths.find((x) => x.id === id);
      return th ? storyPage(page, th, evs, idx) : issue(page, list, idx, evs, ths);
    }
    if (id) {
      const p = [...page.sections.flatMap((x) => x.pieces), ...page.saved].find((x) => x.id === id) || idx.pieces[id];
      // past KEEP_DAYS, or never fetched offline: the piece's text is gone, so read it at its outlet
      const art = await sealed(cfg, pieceRel(want, id)).catch((e) => { if (p && e.status === 404) return { url: p.url }; throw e; });
      return reader(page, art, id, idx, evs, ths);
    }
    issue(page, list, idx, evs, ths);
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
