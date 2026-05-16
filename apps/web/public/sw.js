// Legends Chat service worker — push notifications + minimal install/fetch.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Required by Android Chrome for PWA install eligibility.
// Skip navigation and RSC requests so the browser handles them natively —
// the previous pass-through caused the SW to follow redirects transparently,
// hiding 302s from the Next.js client router and delivering HTML to the RSC
// parser instead of an RSC payload. That killed React hydration in PWA mode.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") return;
  if (
    event.request.headers.has("RSC") ||
    event.request.headers.has("Next-Router-State-Tree") ||
    event.request.headers.has("Next-Router-Prefetch")
  ) return;
  event.respondWith(fetch(event.request).catch(() => new Response(null, { status: 503 })));
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: "Legends Chat", body: event.data.text() };
  }
  const title = data.title || "Legends Chat";
  const body = data.body || "";
  // Route uses /t/[slug]; legacy payloads sent UUID under `topicId` which
  // produced 404s. Prefer the slug field; deep-link to the specific message
  // via ?msg=<id> so the topic view scrolls + highlights it.
  let url = "/";
  if (data.topicSlug) {
    url = `/t/${data.topicSlug}`;
    if (data.messageId) url += `?msg=${encodeURIComponent(data.messageId)}`;
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
