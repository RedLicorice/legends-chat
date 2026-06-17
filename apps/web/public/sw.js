// Legends Chat service worker — SPA shell cache + push notifications.

// Bump on every deploy that needs to invalidate cached SPA shells / bundles.
const CACHE_VERSION = "v8-skip-waiting";
const SHELL_CACHE = `legends-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `legends-static-${CACHE_VERSION}`;

// The catch-all route serves the SPA shell for every authed URL. We cache
// the response to `/` (warmed after first visit) and serve it for any
// in-scope document navigation, so warm navs hit zero server-render.
const SHELL_URL = "/";

// A response is safe to cache + serve to a navigation FetchEvent only when:
//   - it's 2xx (skip CF challenges, 5xx, etc.)
//   - it wasn't transparently redirected (the browser refuses to consume a
//     `redirected: true` response for a navigation whose redirect mode is
//     not "follow")
//   - it isn't a Cloudflare challenge response (cf-mitigated: challenge)
function isCacheableShellResponse(res) {
  if (!res || !res.ok) return false;
  if (res.redirected) return false;
  if (res.headers.get("cf-mitigated") === "challenge") return false;
  return true;
}

// Rebuild a Response from its body so the browser doesn't see the
// `redirected` flag when handing it back to a navigation FetchEvent.
async function stripRedirectedFlag(res) {
  const body = await res.clone().blob();
  return new Response(body, { status: res.status, headers: res.headers });
}

// Honor an explicit SKIP_WAITING from the page so the SwUpdate driver can
// promote a freshly installed SW without waiting for every tab to close.
self.addEventListener("message", (event) => {
  if (event && event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    // Best-effort precache of the shell. If offline, this is a no-op and
    // the shell will be cached on first successful navigation instead.
    try {
      const cache = await caches.open(SHELL_CACHE);
      const res = await fetch(SHELL_URL, { credentials: "include" });
      if (isCacheableShellResponse(res)) await cache.put(SHELL_URL, res.clone());
    } catch {}
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Disable navigation preload — we don't consume preloadResponse, and
    // leaving it enabled spams "navigation preload request was cancelled"
    // warnings on every navigation.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch {}
    }
    // Drop old caches.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n !== SHELL_CACHE && n !== STATIC_CACHE)
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

function isStaticAsset(url) {
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/icon-")) return true;
  if (url.pathname === "/manifest.webmanifest") return true;
  return false;
}

function isApi(url) {
  return url.pathname.startsWith("/api/");
}

function isPublicAuthPath(url) {
  return (
    url.pathname === "/login" ||
    url.pathname === "/register" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/docs/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Same-origin only — never intercept cross-origin requests (analytics, CDNs).
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // RSC requests must pass through untouched — synthesising HTML for the RSC
  // parser breaks React hydration.
  if (
    req.headers.has("RSC") ||
    req.headers.has("Next-Router-State-Tree") ||
    req.headers.has("Next-Router-Prefetch")
  ) {
    return;
  }

  // Document navigations within the SPA: serve cached shell (stale-while-
  // revalidate). Public auth pages bypass the cache so login/register stays
  // fresh and middleware redirects work normally.
  if (req.mode === "navigate") {
    if (isPublicAuthPath(url)) return;
    event.respondWith(navigationHandler(req));
    return;
  }

  // Static asset cache (cache-first).
  if (isStaticAsset(url) && req.method === "GET") {
    event.respondWith(staticHandler(req));
    return;
  }

  // API: network-first, no cache writes (avoid stale auth/data).
  if (isApi(url)) {
    return;
  }

  // Everything else: let the browser handle it.
});

async function navigationHandler(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL);

  // Always revalidate in background. Only cache 2xx, non-redirected,
  // non-CF-challenge responses — anything else would either poison the
  // cache or trip the "redirected response for navigation" failure mode.
  const networkPromise = fetch(SHELL_URL, { credentials: "include" })
    .then(async (res) => {
      if (isCacheableShellResponse(res)) {
        try { await cache.put(SHELL_URL, res.clone()); } catch {}
      }
      return res;
    })
    .catch(() => null);

  if (cached) return cached;

  const net = await networkPromise;
  if (net) {
    // If the response was redirected, the browser will refuse to consume
    // it for a navigation FetchEvent. Strip the flag by rebuilding a fresh
    // Response from the body before handing it back.
    if (net.redirected) return await stripRedirectedFlag(net);
    return net;
  }
  // Last resort: pass through to browser default failure.
  return fetch(req);
}

async function staticHandler(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      try { await cache.put(req, res.clone()); } catch {}
    }
    return res;
  } catch {
    if (cached) return cached;
    throw new Error("static fetch failed and not cached");
  }
}

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
