// Homely Tiffins service worker
// Intentionally does NOT cache API/data responses - all Supabase reads/writes
// must always hit the network so the app never shows stale menu/order/credit data.
// This exists only to satisfy PWA installability requirements and to allow
// future opt-in caching of static shell assets if ever needed.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// No fetch handler that caches anything - pass everything straight to network.
self.addEventListener("fetch", () => {
  // no-op: let the browser handle the request normally
});
