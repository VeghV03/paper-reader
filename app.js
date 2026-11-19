// The morning paper on the phone (decisions D63 to D69). It fetches the sealed edition from the
// reader's private data repository through GitHub's API, opens it here with the run key, and shows
// it. The key never leaves the phone, and the browser will not hand it to any script, this one
// included. Article HTML is cleaned to a short list of tags with no attributes before it is
// shown, and the page's policy runs no script but this file, so text from an outlet cannot act.
"use strict";

const API = location.hostname === "localhost" ? location.origin : "https://api.github.com"; // localhost: a test copy
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // as vault.py: no 0/O or 1/I
const DATA = "paper-data"; // the cache of sealed files, kept for the latest issue only (D37)
const WAIT = 5000; // ms to wait for GitHub before showing the saved copy
const TAGS = new Set(["P", "H2", "H3", "H4", "BLOCKQUOTE", "UL", "OL", "LI", "EM", "I", "STRONG", "B",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BR", "HR", "SUB", "SUP", "CODE", "PRE", "SPAN", "DIV"]);
const DROP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "NOSCRIPT", "FORM"]);
const SETUP = {
  en: { repo: "Data repository", token: "GitHub token", code: "Recovery code", open: "Open the paper",
    bad_code: "A recovery code is 24 letters and digits.", no_repo: "That token can't read that repository.",
    wrong_key: "That code doesn't open this paper.", offline: "No connection, and this isn't saved on the phone.",
    forget: "Forget this phone", no_issue: "No issue yet." },
  hu: { repo: "Adattároló", token: "GitHub-token", code: "Helyreállító kód", open: "Az újság megnyitása",
    bad_code: "A helyreállító kód 24 betű és szám.", no_repo: "Ez a token nem olvassa azt a tárolót.",
    wrong_key: "Ez a kód nem nyitja ezt az újságot.", offline: "Nincs kapcsolat, és ez nincs elmentve a telefonon.",
    forget: "A telefon elfelejtése", no_issue: "Még nincs szám." },
};
const enc = (s) => new TextEncoder().encode(s);
const $main = document.getElementById("main");
let cfg = null; // {repo, token, key}
let lang = navigator.language.toLowerCase().startsWith("hu") ? "hu" : "en";
const s = () => SETUP[lang];

// storage: the phone's own, under its passcode encryption (D65)

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
const load = () => kv("readonly", (st) => st.get("cfg"));
const save = (v) => kv("readwrite", (st) => st.put(v, "cfg"));
const forget = async () => { await kv("readwrite", (st) => st.clear()); await caches.delete(DATA); };

// keys and seals, as cloud.py

function normal(code) {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 24 || [...raw].some((c) => !ALPHABET.includes(c))) throw new Error(s().bad_code);
  return raw.match(/.{4}/g).join("-");
}
async function runKey(code) {
  const base = await crypto.subtle.importKey("raw", enc(normal(code)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc("morning-paper"), info: enc("run v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]); // not extractable
}
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

// GitHub, with the saved copy when it does not answer in time

function gh(c, path, raw) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WAIT);
  return fetch(`${API}/repos/${c.repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${c.token}`, "X-GitHub-Api-Version": "2022-11-28",
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" },
    cache: "no-store", referrerPolicy: "no-referrer", signal: ctl.signal,
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
async function days(c) {
  let buf;
  try {
    buf = await cached("list", () => gh(c, "home/edition"));
  } catch (e) {
    // no edition yet is not a bad token: GitHub says 404 for both, so ask about the repository
    if (e.status === 404 && (await fetch(`${API}/repos/${c.repo}`, {
      headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store" })).ok) return [];
    throw e;
  }
  const names = JSON.parse(new TextDecoder().decode(buf)).map((f) => f.name);
  return names.map((n) => (n.match(/^(\d{4}-\d{2}-\d{2})\.json\.sealed$/) || [])[1]).filter(Boolean).sort();
}
async function sealed(c, rel) {
  const buf = await cached(rel, () => gh(c, `${rel}.sealed`, true));
  return unseal(c.key, rel, buf);
}
const frontRel = (day) => `home/edition/${day}.json`;
const pieceRel = (day, id) => `home/edition/${day}/${id}.json`;

// keep the latest issue whole for offline reading, and nothing older (D37)
async function keep(c, page) {
  const ids = [...page.sections.flatMap((x) => x.pieces), ...page.saved].map((p) => p.id);
  for (const id of ids) await sealed(c, pieceRel(page.day, id)).catch(() => {});
  const cache = await caches.open(DATA);
  const mine = new Set(["list", frontRel(page.day), ...ids.map((id) => pieceRel(page.day, id))].map(saved));
  for (const req of await cache.keys()) if (!mine.has(req.url)) await cache.delete(req);
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
  const [y, m, d] = day.split("-").map(Number);
  const month = page.labels.months.split(" ")[m - 1];
  return page.lang === "hu" ? `${month} ${d}.` : `${d} ${month}`;
}
function show(title, body, nav = "") {
  document.title = title;
  document.documentElement.lang = lang;
  $main.innerHTML = body + nav;
  scrollTo(0, 0);
}
function navFor(page, list) {
  const i = list.indexOf(page.day);
  const prev = i > 0 ? `<a href="#${list[i - 1]}">← ${esc(short(page, list[i - 1]))}</a>` : "<span></span>";
  const next = i >= 0 && i + 1 < list.length ? `<a href="#${list[i + 1]}">${esc(short(page, list[i + 1]))} →</a>` : "<span></span>";
  return `<nav>${prev}<span class=links><a href="#forget">${esc(s().forget)}</a></span>${next}</nav>`;
}
function issue(page, list) {
  const t = page.labels;
  const item = (p, lead) => `<li><a href="#${page.day}/${esc(p.id)}">${esc(p.head)}</a>` +
    (lead && p.lead ? `<p>${esc(p.lead)}</p>` : "") + `<span>${esc(p.host)}</span></li>`;
  const parts = page.sections.map((x) => `<section><h2>${esc(x.name)}</h2><ol>${x.pieces.map((p) => item(p, true)).join("")}</ol></section>`);
  if (page.saved.length) parts.push(`<section><h2>${esc(t.saved)}</h2><ol>${page.saved.map((p) => item(p, false)).join("")}</ol></section>`);
  if (!parts.length) parts.push(`<p class=empty>${esc(t.empty)}</p>`);
  show(page.dateline, `<h1>${esc(page.dateline)}</h1>${parts.join("")}`, navFor(page, list));
}
function reader(page, art, id) {
  const t = page.labels;
  if (!art.html) { location.replace(art.url); return; } // the site refused: read it there
  const seq = [...page.sections.flatMap((x) => x.pieces), ...page.saved];
  const at = seq.findIndex((p) => p.id === id);
  const nxt = seq[at + 1];
  const after = nxt ? `<a class=next href="#${page.day}/${esc(nxt.id)}"><span>${esc(t.next)}</span>${esc(nxt.head)}</a>`
    : `<a class=next href="#${page.day}/done">${esc(t.done)}</a>`;
  const head = `<header><a href="#${page.day}">← ${esc(short(page, page.day))}</a></header>` +
    `<h1 class=title>${esc(art.title)}</h1>` + (art.byline ? `<p class=byline>${esc(art.byline)}</p>` : "");
  const foot = `<footer><span></span><a href="${esc(art.url)}" rel="noreferrer">${esc(t.original)} ↗</a></footer>${after}`;
  show(art.title, head + `<article>${clean(art.html)}</article>`, foot);
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
      const c = { repo: f.get("repo").trim(), token: f.get("token").trim(), key: await runKey(f.get("code")) };
      const res = await gh(c, "home/sections.md.sealed", true); // every paper has one: a wrong code fails here
      if (!res.ok) throw new Error(t.no_repo);
      await unseal(c.key, "home/sections.md", await res.arrayBuffer(), true);
      await save(c);
      cfg = c;
      route();
    } catch (e) {
      setup(e.message, { repo: f.get("repo"), token: f.get("token") }); // the code is typed again
    }
  });
}

async function route() {
  const where = decodeURIComponent(location.hash.slice(1));
  if (where === "forget") {
    if (confirm(s().forget + "?")) { await forget(); cfg = null; location.hash = ""; return setup(); }
    return history.back();
  }
  if (!cfg) return setup();
  try {
    const list = await days(cfg);
    if (!list.length) return show("Paper", `<p class=empty>${esc(s().no_issue)}</p>`);
    const [day, id] = where.split("/");
    const want = list.includes(day) ? day : list.at(-1);
    const page = await sealed(cfg, frontRel(want));
    lang = page.lang in SETUP ? page.lang : lang;
    if (id === "done") return done(page, list);
    if (id) {
      const p = [...page.sections.flatMap((x) => x.pieces), ...page.saved].find((x) => x.id === id);
      // past KEEP_DAYS, or never fetched offline: the piece's text is gone, so read it at its outlet
      const art = await sealed(cfg, pieceRel(want, id)).catch((e) => { if (p && e.status === 404) return { url: p.url }; throw e; });
      return reader(page, art, id);
    }
    issue(page, list);
    if (want === list.at(-1)) keep(cfg, page);
  } catch (e) {
    if (e.wrongKey || e.status === 401) return setup(e.message); // a new token or code
    show("Paper", `<p class=empty>${esc(e.message)}</p>`);
  }
}

addEventListener("hashchange", route);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
load().then((c) => { cfg = c || null; route(); }, () => route());
