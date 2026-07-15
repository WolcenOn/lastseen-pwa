const CACHE_VERSION = "lastseen-v4";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./room.html",
  "./manifest.json",
  "./config.js",
  "./assets/css/app.css",
  "./assets/icons/icon.svg",
  "./src/app.js"
];

function shouldBypassCache(request) {
  const url = new URL(request.url);

  if (request.method !== "GET") return true;
  if (url.pathname.includes("/ws/")) return true;
  if (url.pathname.includes("/api/")) return true;

  return false;
}

self.addEventListener("install", event => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => !key.startsWith(CACHE_VERSION)).map(key => caches.delete(key))
    ))
  );

  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const { request } = event;

  if (shouldBypassCache(request)) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request)
        .then(response => {
          if (!response || response.status !== 200) return response;

          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          if (request.mode === "navigate") {
            return caches.match("./room.html").then(fallback => fallback || caches.match("./index.html"));
          }

          return new Response("", { status: 503, statusText: "Offline" });
        });
    })
  );
});
