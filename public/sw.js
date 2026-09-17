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

// ── Web Push ──
// Displays whatever the send-push API route sent (order status updates,
// or an owner broadcast). Payload is always JSON: { title, body, url? }.
self.addEventListener("push", (event) => {
  let data = { title: "Homely Tiffins", body: "You have an update." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // Non-JSON payload (shouldn't happen from our own backend) — fall back
    // to the default text above rather than throwing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Tapping the notification focuses an existing tab if one is open, else
// opens a new one at the target URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
