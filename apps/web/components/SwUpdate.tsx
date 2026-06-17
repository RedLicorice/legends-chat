"use client";

import { useEffect } from "react";

// Service worker update driver. Sits at the layout level (always mounted).
//
// Why this exists: by spec the browser will refetch sw.js at most once every
// 24h. iOS Safari is even worse — without an explicit update() call the
// installed PWA can keep stale chunks across multiple deploys. This component:
//   1. Registers the SW (if not already)
//   2. Calls registration.update() on mount, on tab focus, on online events,
//      and on a 60-minute interval — every call hits the server now that
//      we serve sw.js with no-store
//   3. When a new SW finishes installing (becomes `waiting`), tells it to
//      skipWaiting and reloads the page on controllerchange so the user is
//      always on the freshest chunks without a manual hard refresh
//
// Single instance per page is enough; mount in app/layout.tsx alongside
// PushSetup.
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1h fallback ping

export function SwUpdate(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let intervalId: number | null = null;
    let reloading = false;

    async function setup() {
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (cancelled) return;

      // Push a waiting worker into active state. Safe because activation also
      // clears old caches and claims clients.
      const skipWaiting = (sw: ServiceWorker | null) => {
        if (sw && sw.state === "installed") {
          try { sw.postMessage({ type: "SKIP_WAITING" }); } catch {
            // SW may not handle the message; no-op.
          }
        }
      };

      if (reg.waiting) skipWaiting(reg.waiting);

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            // A new SW took the waiting slot — promote it.
            skipWaiting(installing);
          }
        });
      });

      // When the active SW switches, soft-reload so the page picks up the new
      // chunk graph. Guarded so we don't loop on devtools "Update on reload".
      const onControllerChange = () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

      // Always probe on mount; sw.js is now no-store so each call hits the
      // server. The browser will diff bytes vs the running SW and trigger
      // update lifecycle only when needed.
      try { await reg.update(); } catch {
        // Network issue; next interval will retry.
      }

      const tick = () => { reg.update().catch(() => undefined); };
      intervalId = window.setInterval(tick, UPDATE_INTERVAL_MS);

      const onFocus = () => tick();
      const onVisible = () => { if (document.visibilityState === "visible") tick(); };
      const onOnline = () => tick();
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onOnline);

      return () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", onOnline);
      };
    }

    const cleanupPromise = setup();
    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      cleanupPromise.then((fn) => fn?.()).catch(() => undefined);
    };
  }, []);

  return null;
}
