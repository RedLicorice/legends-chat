"use client";
import { useEffect } from "react";

// Proactively refresh the access token before it expires.
// Default TTL is 900 s; refresh at 840 s to give a 60-second buffer.
const INTERVAL = 840_000;

export function TokenRefresh() {
  useEffect(() => {
    const id = setInterval(() => {
      fetch("/api/auth/refresh", { method: "POST" }).catch(() => {});
    }, INTERVAL);
    return () => clearInterval(id);
  }, []);
  return null;
}
