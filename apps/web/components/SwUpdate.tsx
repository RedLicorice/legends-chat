"use client";

import { useEffect } from "react";
import { SW_URL } from "@/lib/sw";

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

    // Captured at mount: if the page is uncontrolled now (first install,
    // post-unregister), an upcoming controllerchange would be the FIRST
    // controller — that is a fresh install, not an update. We only reload
    // when we transition from one controller to another (a real update).
    const hadInitialController = !!navigator.serviceWorker.controller;

    const state: {
      cancelled: boolean;
      intervalId: number | null;
      reg: ServiceWorkerRegistration | null;
      reloading: boolean;
      updateFoundHandler: (() => void) | null;
      onControllerChange: (() => void) | null;
      onFocus: (() => void) | null;
      onVisible: (() => void) | null;
      onOnline: (() => void) | null;
    } = {
      cancelled: false,
      intervalId: null,
      reg: null,
      reloading: false,
      updateFoundHandler: null,
      onControllerChange: null,
      onFocus: null,
      onVisible: null,
      onOnline: null,
    };

    void (async () => {
      const reg = await navigator.serviceWorker.register(SW_URL);
      if (state.cancelled) return;
      state.reg = reg;

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

      const updateFoundHandler = () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            skipWaiting(installing);
          }
        });
      };
      state.updateFoundHandler = updateFoundHandler;
      reg.addEventListener("updatefound", updateFoundHandler);

      // When the active SW switches, soft-reload so the page picks up the new
      // chunk graph. Guarded so we don't loop on devtools "Update on reload"
      // and skipped on the first-ever install (hadInitialController=false)
      // since that's not a real update.
      const onControllerChange = () => {
        if (state.reloading) return;
        if (!hadInitialController) return;
        state.reloading = true;
        window.location.reload();
      };
      state.onControllerChange = onControllerChange;
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

      // Always probe on mount; sw.js is now no-store so each call hits the
      // server. The browser will diff bytes vs the running SW and trigger
      // update lifecycle only when needed.
      try { await reg.update(); } catch {
        // Network issue; next interval will retry.
      }
      if (state.cancelled) return;

      const tick = () => { reg.update().catch(() => undefined); };
      state.intervalId = window.setInterval(tick, UPDATE_INTERVAL_MS);

      const onFocus = () => tick();
      const onVisible = () => { if (document.visibilityState === "visible") tick(); };
      const onOnline = () => tick();
      state.onFocus = onFocus;
      state.onVisible = onVisible;
      state.onOnline = onOnline;
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onOnline);
    })();

    return () => {
      state.cancelled = true;
      if (state.intervalId !== null) {
        window.clearInterval(state.intervalId);
        state.intervalId = null;
      }
      if (state.reg && state.updateFoundHandler) {
        state.reg.removeEventListener("updatefound", state.updateFoundHandler);
      }
      if (state.onControllerChange) {
        navigator.serviceWorker.removeEventListener("controllerchange", state.onControllerChange);
      }
      if (state.onFocus) window.removeEventListener("focus", state.onFocus);
      if (state.onVisible) document.removeEventListener("visibilitychange", state.onVisible);
      if (state.onOnline) window.removeEventListener("online", state.onOnline);
    };
  }, []);

  return null;
}
