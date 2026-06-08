"use client";

// Pure visual loading placeholder. No navigation side effects — the
// "restore last topic on cold start" behaviour lives in AppShell so it
// fires exactly once per tab session, not on every loader mount (the
// latter caused internal /-navigations to redirect right back).
export function PWASplash() {
  return <div className="h-dvh bg-bg" />;
}
