"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HomeView } from "@/components/views/HomeView";
import { TopicView } from "@/components/views/TopicView";
import { DMListView } from "@/components/views/DMListView";
import { DMThreadView } from "@/components/views/DMThreadView";
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

export function AppShell() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const coldBootHandledRef = useRef(false);

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

  return useMemo(() => {
    // Normalize trailing slash (Next typically strips, but be defensive).
    const path = pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

    // Exact matches first.
    if (path === "/" || path === "") return <HomeView />;
    if (path === "/dm") return <DMListView />;
    if (path === "/settings") return <SettingsView />;
    if (path === "/admin") {
      return (
        <AdminShellView>
          {renderAdminPanel("overview")}
        </AdminShellView>
      );
    }

    // Topic: /t/<slug>
    if (path.startsWith("/t/")) {
      const slug = path.slice(3).split("/")[0];
      return <TopicView slug={slug || undefined} />;
    }

    // DM thread: /dm/<id>
    if (path.startsWith("/dm/")) {
      const id = path.slice(4).split("/")[0];
      return <DMThreadView id={id || undefined} />;
    }

    // Admin panels: /admin/<panel>
    if (path.startsWith("/admin/")) {
      const sub = path.slice(7).split("/")[0] as AdminPanelKey;
      const key = ADMIN_PANELS.has(sub) ? sub : null;
      return (
        <AdminShellView>
          {renderAdminPanel(key)}
        </AdminShellView>
      );
    }

    return <NotFoundPanel />;
  }, [pathname]);
}
