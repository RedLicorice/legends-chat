"use client";
import { useEffect } from "react";
import { apiFetch } from "@/lib/fetch";

// Refresh the access token exactly once per expiry window, scheduled off the
// JWT `exp` claim returned by /api/me. No fixed interval, no polling: a
// single setTimeout that re-arms itself after each successful refresh.

const REFRESH_LEAD_MS = 30_000; // refresh 30s before expiry

const AUTH_PATHS = ["/login", "/register", "/auth/"];

function isPublic(): boolean {
  if (typeof window === "undefined") return false;
  return AUTH_PATHS.some((p) => window.location.pathname.startsWith(p));
}

async function readExpiry(): Promise<number | null> {
  try {
    const r = await apiFetch("/api/me");
    if (!r.ok) return null;
    const d = (await r.json()) as { tokenExpiresAt?: string | null };
    if (!d.tokenExpiresAt) return null;
    const t = Date.parse(d.tokenExpiresAt);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function TokenRefresh() {
  useEffect(() => {
    if (isPublic()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = async () => {
      if (cancelled) return;
      const expiresAt = await readExpiry();
      if (cancelled) return;
      if (expiresAt === null) {
        // Couldn't determine expiry — bail rather than guess an interval.
        return;
      }
      const wait = Math.max(0, expiresAt - Date.now() - REFRESH_LEAD_MS);
      timer = setTimeout(async () => {
        if (cancelled) return;
        const ok = await fetch("/api/auth/refresh", { method: "POST" })
          .then((r) => r.ok)
          .catch(() => false);
        if (cancelled) return;
        if (!ok) {
          if (!isPublic()) window.location.replace("/login");
          return;
        }
        void schedule();
      }, wait);
    };

    void schedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}
