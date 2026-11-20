// The reader's own files as Settings on the phone reads and saves them (D75, D83, D87, D88). Each
// save checks what it writes as settings.py does on the Mac, so a bad edit is refused with its
// reason before it is sealed; tests/test_settings_js.py holds the two alike. Errors are the Mac's.
"use strict";

const SECTIONS_HEAD = "# The paper's sections, in page order.\n" +
  "# One line each: the name, a colon, what belongs in it; topics after a | steer the section.\n\n";
const NAME_CHARS = 32;
const MAX_SECTIONS = 8;
const LANGS = ["en", "hu"];
const WEB = /^https?:\/\/\S+$/;

class Invalid extends Error {
  constructor(errors) { super(errors.join(" · ")); this.errors = errors; }
}
const chars = (x) => [...x].length; // as Python counts: code points
function oneLine(value, field, limit) {
  const text = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (limit && chars(text) > limit) throw new Invalid([`${field} is ${chars(text)} characters; ${limit} at most`]);
  return text;
}
// the name in lower case, accents dropped, spaces as "-" (issue.section_id)
const sectionId = (name) => name.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// sections.md, as issue.sections reads it: [{name, what, topics}]
function readSections(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const rest = line.slice(at + 1), bar = rest.indexOf("|");
    const name = line.slice(0, at).trim(), what = (bar < 0 ? rest : rest.slice(0, bar)).trim();
    const topics = bar < 0 ? [] : rest.slice(bar + 1).split(",").map((x) => x.trim()).filter(Boolean);
    if (sectionId(name) && !out.some((s) => sectionId(s.name) === sectionId(name))) out.push({ name, what, topics: topics.join(", ") });
  }
  return out;
}
// settings.save_sections: the rows as the page has them, written as the file
function writeSections(rows) {
  const lines = [], ids = new Set(), errors = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = oneLine(r.name, "a name", NAME_CHARS), what0 = oneLine(r.what, "what belongs");
    const topics = String(r.topics || "").split(",").map((x) => oneLine(x, "a topic")).filter(Boolean);
    if (!name && !what0) continue;
    if (!name || name.includes(":") || name.includes("|") || !sectionId(name)) {
      errors.push(`'${name}': a name needs a letter, and no : or |`);
      continue;
    }
    if (ids.has(sectionId(name))) errors.push(`'${name}' is there twice`);
    ids.add(sectionId(name));
    const what = what0.replaceAll("|", "/");
    lines.push(`${name}: ${what}` + (topics.length ? ` | ${topics.map((t) => t.replaceAll("|", "/")).join(", ")}` : ""));
  }
  if (lines.length > MAX_SECTIONS) errors.push(`${lines.length} sections; an issue holds ${MAX_SECTIONS}`);
  if (!lines.length) errors.push("the paper needs a section");
  if (errors.length) throw new Invalid(errors);
  return SECTIONS_HEAD + lines.join("\n") + "\n";
}
const writeInterests = (text) => String(text ?? "").replace(/\s+$/, "") + "\n";

// feeds.yaml, a line at a time (D88): each feed is one `- {name: …, url: …}` line under `feeds:`,
// and every other line (topics, limits, notes) stays as written
function flowMap(line) { // `- {name: X, url: "Y", topic: z}` -> {name, url}, or null when it is not one line
  const m = line.match(/^\s*-\s*\{(.*)\}\s*$/);
  if (!m) return null;
  const out = {}, body = m[1];
  let i = 0;
  while (i < body.length) {
    const key = body.slice(i).match(/^\s*([A-Za-z_]+)\s*:\s*/);
    if (!key) return null;
    i += key[0].length;
    let value;
    if (body[i] === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += body[j] === "\\" ? 2 : 1;
      try { value = JSON.parse(body.slice(i, j + 1)); } catch { return null; }
      i = j + 1;
    } else if (body[i] === "'") {
      let j = i + 1;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'")) j += body[j] === "'" ? 2 : 1;
      value = body.slice(i + 1, j).replaceAll("''", "'");
      i = j + 1;
    } else {
      const end = body.indexOf(",", i);
      value = body.slice(i, end < 0 ? body.length : end).trim();
      i = end < 0 ? body.length : end;
    }
    out[key[1]] = value;
    const comma = body.slice(i).match(/^\s*,?/);
    i += comma[0].length;
  }
  return out;
}
// the feeds, each with its line; `editable` is false when a feed is written over several lines
function readFeeds(text) {
  const lines = String(text || "").split("\n"), feeds = [];
  let inside = false, editable = true;
  lines.forEach((line, n) => {
    if (/^feeds:/.test(line)) { inside = true; if (/^feeds:\s*\[\s*\]\s*$/.test(line)) inside = false; return; }
    if (inside && /^\S/.test(line) && !line.startsWith("#")) inside = false;
    if (!inside || !/^\s*-/.test(line)) return;
    const f = flowMap(line);
    if (f && typeof f.url === "string") feeds.push({ line: n, name: String(f.name ?? ""), url: f.url });
    else editable = false;
  });
  return { feeds, editable };
}
function removeFeed(text, url) {
  const { feeds } = readFeeds(text), lines = String(text).split("\n");
  const gone = new Set(feeds.filter((f) => f.url === url).map((f) => f.line));
  return lines.filter((_, n) => !gone.has(n)).join("\n");
}
function addFeed(text, name0, url0) {
  const name = oneLine(name0, "a name"), url = oneLine(url0, "an address");
  if (!WEB.test(url)) throw new Invalid([`'${url}' is not a web address`]);
  const item = `{name: ${JSON.stringify(name || url)}, url: ${JSON.stringify(url)}}`;
  const lines = String(text || "").split("\n");
  const { feeds } = readFeeds(text);
  if (feeds.length) {
    const last = feeds.at(-1), indent = lines[last.line].match(/^\s*/)[0];
    lines.splice(last.line + 1, 0, `${indent}- ${item}`);
    return lines.join("\n");
  }
  const at = lines.findIndex((l) => /^feeds:/.test(l));
  if (at >= 0) { lines.splice(at, 1, "feeds:", `  - ${item}`); return lines.join("\n"); }
  return String(text || "").replace(/\n*$/, "\n") + `feeds:\n  - ${item}\n`;
}

// outlets.json: the Mac's settings removes a newsroom whole, all its feeds; Claude adds them
function newsrooms(outlets) {
  const out = new Map();
  for (const o of Array.isArray(outlets) ? outlets : []) {
    if (!o || typeof o !== "object" || !("id" in o)) continue;
    const org = o.org || o.id;
    if (!out.has(org)) out.set(org, { org, ids: [] });
    out.get(org).ids.push(o.id);
  }
  return [...out.values()];
}
function writeOutlets(outlets, keep) {
  const wanted = new Set((Array.isArray(keep) ? keep : []).map(String));
  const left = (Array.isArray(outlets) ? outlets : []).filter((o) => o && typeof o === "object" && wanted.has(o.id));
  if (!left.length) throw new Invalid(["the paper needs an outlet"]);
  return JSON.stringify(left, null, 1) + "\n";
}

// paper.yaml's language line
const readLanguage = (text) => {
  const m = String(text || "").match(/^language:\s*["']?(\w+)/m);
  return m && LANGS.includes(m[1]) ? m[1] : "en";
};
function writeLanguage(text, lang) {
  if (!LANGS.includes(lang)) throw new Invalid([`the page speaks ${LANGS.join(" or ")}`]);
  text = String(text || "");
  if (/^language:.*$/m.test(text)) return text.replace(/^language:.*$/gm, `language: ${lang}`);
  return text.replace(/\n+$/, "") + (text ? "\n" : "") + `language: ${lang}\n`;
}

// a saved link: its own file, folded into inbox.md by the run (D86)
function savedLink(value) {
  const url = oneLine(value, "a link");
  if (!WEB.test(url)) throw new Invalid([`'${url}' is not a web address`]);
  return url;
}
