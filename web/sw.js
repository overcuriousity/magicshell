// Makes magicshell installable and shows an offline page when the server cannot be reached.
// Caches only that page and what it needs; setups, history and API answers are never cached.
// The server fills in its version below, so each release replaces the cache.
const VERSION = "magicshell-__VERSION__";
const OFFLINE = "/offline.html";
const SHELL = [
  OFFLINE,
  "/js/ui/theme-boot.js",
  "/css/00-tokens.css",
  "/css/10-base.css",
  "/css/20-layout.css",
  "/css/30-components.css",
  "/css/35-everyday.css",
  "/css/40-app.css",
  "/fonts/atkinson-next-400.woff2",
  "/icon.svg",
];
const NEVER = ["/api/", "/auth/"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (NEVER.some((p) => url.pathname.startsWith(p))) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  }
});
