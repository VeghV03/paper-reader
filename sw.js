// The page's own files, kept so the paper opens without a network. Issues are cached by app.js,
// still sealed. A new version of this file replaces the cached code on the next open.
const SHELL = "shell-v2";
const FILES = ["./", "index.html", "learn.js", "app.js", "style.css", "icon.png",
  "fonts/PaperSerif-Roman.woff2", "fonts/PaperSerif-Italic.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const shell = FILES.map((f) => new URL(f, self.registration.scope).pathname);
  if (e.request.method !== "GET" || url.origin !== location.origin || !shell.includes(url.pathname)) return;
  // the network first, so a merged update shows; the saved copy when there is none
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
    return res.clone();
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("./"))));
});
