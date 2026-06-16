"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useSessionBootstrap } from "@/contexts/SessionBootstrapContext";

const AUTH_PATHS = ["/login", "/register", "/auth/"];

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buf;
}

export function PushSetup() {
  const pathname = usePathname();
  const { bootstrap } = useSessionBootstrap();
  const vapidKey = bootstrap?.pushVapidPublicKey ?? null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (pathname && AUTH_PATHS.some((p) => pathname.startsWith(p))) return;
    if (!vapidKey) return;

    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        const existing = await reg.pushManager.getSubscription();
        if (existing) return;

        // Modern browsers (Chrome 80+, Firefox) require Notification.requestPermission()
        // and pushManager.subscribe() to be triggered from a user gesture. Calling
        // them on mount silently fails with AbortError. Only proceed when the user
        // has already granted permission via an explicit gesture elsewhere.
        // TODO: add a settings UI button that gestures into a subscribe flow for
        // users whose permission is still "default".
        if (typeof Notification === "undefined") return;
        if (Notification.permission !== "granted") {
          console.info(
            "[push] skipping auto-subscribe: notification permission is",
            Notification.permission,
            "(user must opt in via a gesture)",
          );
          return;
        }

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(vapidKey),
        });
        const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
        await apiFetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: json.endpoint,
            p256dh: json.keys.p256dh,
            auth: json.keys.auth,
            deviceLabel: navigator.userAgent.slice(0, 120),
          }),
        });
      } catch (err) {
        console.warn("[push] setup failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, vapidKey]);

  return null;
}
