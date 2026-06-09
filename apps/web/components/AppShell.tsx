"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChatShell } from "@/components/ChatShell";
import { HomeRightPane } from "@/components/views/HomeRightPane";
import { TopicRightPane } from "@/components/views/TopicRightPane";
import { DMListView } from "@/components/views/DMListView";
import { DmRightPane } from "@/components/views/DmRightPane";
import { SettingsView } from "@/components/views/SettingsView";
import { AdminShellView } from "@/components/views/AdminShellView";
import { AdminOverviewView } from "@/components/views/AdminOverviewView";
import { AdminBansView } from "@/components/views/AdminBansView";
import { AdminBotsView } from "@/components/views/AdminBotsView";
import { AdminGifsView } from "@/components/views/AdminGifsView";
import { AdminInvitesView } from "@/components/views/AdminInvitesView";
import { AdminModerationView } from "@/components/views/AdminModerationView";
import { AdminNotificationsView } from "@/components/views/AdminNotificationsView";
import { AdminRolesView } from "@/components/views/AdminRolesView";
import { AdminSettingsView } from "@/components/views/AdminSettingsView";
import { AdminSymbolsView } from "@/components/views/AdminSymbolsView";
import { AdminThemesView } from "@/components/views/AdminThemesView";
import { AdminTopicsView } from "@/components/views/AdminTopicsView";
import { AdminUsersView } from "@/components/views/AdminUsersView";

/**
 * Single-page-app entry point. The catch-all route at
 * `app/(app)/[[...slug]]/page.tsx` always renders this component for any
 * non-public URL. We read `usePathname()` and dispatch to the matching view
 * — no nested page.tsx files, no per-route bundles.
 *
 * Chat-shaped routes (`/`, `/t/*`, `/c`, `/c/*`) are wrapped in a single
 * stable `<ChatShell>` that owns the sidebar + ChatListPane + their sockets.
 * Only the right pane element type changes when the pathname changes, so
 * React keeps the shell mounted across navigation (no re-fetch, no socket
 * reconnect, no DOM churn).
 *
 * URL contract is preserved: existing `<Link href="/...">` calls keep working
 * because the Next router still navigates between paths; this component just
 * re-dispatches on pathname change.
 */

type AdminPanelKey =
  | "overview"
  | "bans"
  | "bots"
  | "gifs"
  | "invites"
  | "moderation"
  | "notifications"
  | "roles"
  | "settings"
  | "symbols"
  | "themes"
  | "topics"
  | "users";

function renderAdminPanel(key: AdminPanelKey | null): React.ReactNode {
  switch (key) {
    case "overview":
      return <AdminOverviewView />;
    case "bans":
      return <AdminBansView />;
    case "bots":
      return <AdminBotsView />;
    case "gifs":
      return <AdminGifsView />;
    case "invites":
      return <AdminInvitesView />;
    case "moderation":
      return <AdminModerationView />;
    case "notifications":
      return <AdminNotificationsView />;
    case "roles":
      return <AdminRolesView />;
    case "settings":
      return <AdminSettingsView />;
    case "symbols":
      return <AdminSymbolsView />;
    case "themes":
      return <AdminThemesView />;
    case "topics":
      return <AdminTopicsView />;
    case "users":
      return <AdminUsersView />;
    default:
      return <NotFoundPanel />;
  }
}

const ADMIN_PANELS: ReadonlySet<AdminPanelKey> = new Set([
  "bans",
  "bots",
  "gifs",
  "invites",
  "moderation",
  "notifications",
  "roles",
  "settings",
  "symbols",
  "themes",
  "topics",
  "users",
]);

function NotFoundPanel() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted">
        We couldn&apos;t find what you were looking for.
      </p>
      <a
        href="/"
        className="mt-2 rounded-md bg-panel2 px-3 py-1.5 text-sm hover:bg-panel"
      >
        Go home
      </a>
    </div>
  );
}

// Session-scoped flag that signals "we already considered cold-boot restore
// in this tab." Prevents the SPA from auto-redirecting to the last topic
// every time the user navigates to "/" intentionally.
const COLD_BOOT_FLAG = "lc-spa-mounted";
const LAST_TOPIC_KEY = "lc-last-topic";

type Route =
  | { kind: "chat"; rightPane: React.ReactNode }
  | { kind: "admin"; panel: AdminPanelKey | null }
  | { kind: "settings" }
  | { kind: "notFound" };

function resolveRoute(rawPath: string): Route {
  const path =
    rawPath.length > 1 && rawPath.endsWith("/")
      ? rawPath.slice(0, -1)
      : rawPath;

  if (path === "/" || path === "") {
    return { kind: "chat", rightPane: <HomeRightPane /> };
  }
  if (path === "/c") {
    return { kind: "chat", rightPane: <DMListView /> };
  }
  if (path === "/settings") {
    return { kind: "settings" };
  }
  if (path === "/admin") {
    return { kind: "admin", panel: "overview" };
  }
  if (path.startsWith("/t/")) {
    const slug = path.slice(3).split("/")[0] || "";
    return { kind: "chat", rightPane: <TopicRightPane slug={slug} /> };
  }
  if (path.startsWith("/c/")) {
    const id = path.slice(3).split("/")[0] || "";
    return { kind: "chat", rightPane: <DmRightPane id={id} /> };
  }
  if (path.startsWith("/admin/")) {
    const sub = path.slice(7).split("/")[0] as AdminPanelKey;
    const key = ADMIN_PANELS.has(sub) ? sub : null;
    return { kind: "admin", panel: key };
  }
  return { kind: "notFound" };
}

export function AppShell() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const coldBootHandledRef = useRef(false);

  // Backward-compat: the DM URL slug was renamed from `/dm` to `/c`. Old PWA
  // shortcuts, pasted links, and push notifications still target `/dm/...`,
  // so we rewrite them to `/c/...` here. `router.replace` (not `push`) so the
  // legacy URL doesn't sit in history and the Back button skips over it.
  useEffect(() => {
    if (pathname === "/dm") {
      router.replace("/c");
      return;
    }
    if (pathname.startsWith("/dm/")) {
      router.replace(`/c/${pathname.slice(4)}`);
    }
  }, [pathname, router]);

  // Cold-boot restore: if this is the FIRST mount of the SPA in this tab
  // session AND the user landed on "/", jump them to the topic they had
  // open last time (best-effort, localStorage). On any other path, leave
  // them where they are.
  useEffect(() => {
    if (coldBootHandledRef.current) return;
    coldBootHandledRef.current = true;
    try {
      if (sessionStorage.getItem(COLD_BOOT_FLAG)) return;
      sessionStorage.setItem(COLD_BOOT_FLAG, "1");
      if (pathname !== "/" && pathname !== "") return;
      const last = localStorage.getItem(LAST_TOPIC_KEY);
      if (last) router.replace(`/t/${last}`);
    } catch {
      // SessionStorage / localStorage may throw in privacy modes — best-effort.
    }
  }, [pathname, router]);

  const route = useMemo(() => resolveRoute(pathname), [pathname]);

  // Chat-shaped routes return ONE element type — `<ChatShell>` — so React's
  // reconciler keeps the shell mounted and only swaps `children`. Admin and
  // Settings live outside the chat shell intentionally (different chrome).
  if (route.kind === "chat") {
    return <ChatShell>{route.rightPane}</ChatShell>;
  }
  if (route.kind === "admin") {
    return <AdminShellView>{renderAdminPanel(route.panel)}</AdminShellView>;
  }
  if (route.kind === "settings") {
    return <SettingsView />;
  }
  return <NotFoundPanel />;
}
