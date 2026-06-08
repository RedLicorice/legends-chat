"use client";

import { usePathname } from "next/navigation";
import { AppShell } from "@/components/AppShell";

// Paths where AppShell must NOT render — public surfaces own their own UI.
// Everything else falls through to AppShell, which dispatches the matching
// authed view by pathname.
const PUBLIC_PREFIXES = [
  "/login",
  "/register",
  "/auth/",
  "/docs/",
];

function isPublic(path: string): boolean {
  for (const p of PUBLIC_PREFIXES) {
    if (path === p || path.startsWith(p)) return true;
  }
  return false;
}

/**
 * Root-layout-level switch. Public pages render their own page tree
 * directly (`children` = whatever the route's page.tsx returned). Authed
 * pages render `<AppShell />` — a single instance that lives at the root
 * layout boundary so it NEVER unmounts on navigation. The sidebar inside
 * AppShell stays as the exact same DOM nodes regardless of pathname or
 * query string changes.
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (isPublic(pathname)) return <>{children}</>;
  return <AppShell />;
}
