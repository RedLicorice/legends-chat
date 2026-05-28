"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

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
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (pathname && AUTH_PATHS.some((p) => pathname.startsWith(p))) return;

    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        const existing = await reg.pushManager.getSubscription();
        if (existing) return;

        const vapid = await apiFetch("/api/push/vapid").then((r) => r.json());
        if (!vapid.publicKey) return;
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(vapid.publicKey),
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
  }, [pathname]);

  return null;
}
