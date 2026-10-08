// Minimal app-shell service worker so the app can load at all when the
// phone has no internet. It does NOT cache API responses - those are
// handled by offline.js's IndexedDB cache instead, so data is always
// explicit and shop-scoped rather than silently stale HTTP cache.
const CACHE_NAME = "dukaansaathi-shell-v1";
const SHELL_FILES = [
  "/",
  "/assets/style.css",
  "/assets/api.js",
  "/assets/offline.js",
  "/assets/app.js",
  "/assets/app2.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API calls - those must either succeed live or be
  // handled explicitly by the app's offline queue, never served stale.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res.ok && event.request.method === "GET") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match("/"));
    })
  );
});
