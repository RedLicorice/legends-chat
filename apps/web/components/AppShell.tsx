"use client";

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useIsMobile } from "@/hooks/useIsMobile";
import { routeLevel, backTarget } from "@/lib/mobile-nav";
import { ArrowLeft, Menu, PanelLeftOpen, Hash } from "lucide-react";
import { PERMISSIONS } from "@legends/shared";
import { AppSidebar, AdminNav } from "@/components/AppSidebar";
import { MobileStack } from "@/components/MobileStack";
import { ChatListPane } from "@/components/ChatListPane";
import { PWASplash, markSpaPainted } from "@/components/PWASplash";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import { useChatListContext } from "@/contexts/ChatListContext";
import { HomeRightPane } from "@/components/views/HomeRightPane";
import { TopicRightPane } from "@/components/views/TopicRightPane";
import { DMListView } from "@/components/views/DMListView";
import { DmRightPane } from "@/components/views/DmRightPane";
import { DmComposeNewView } from "@/components/views/DmComposeNewView";
import { SettingsView } from "@/components/views/SettingsView";
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
 * Single-container persistent SPA shell.
 *
 * AppShell is the ONE client component rendered from `app/layout.tsx`. It
 * lives at the root-layout boundary so it never unmounts on navigation.
 * Public paths (login / register / auth / docs) short-circuit and render
 * `children` unmodified. Every other path renders the persistent outer flex
 * container with `<AppSidebar>` + `<main>`. The container shape is identical
 * across every authed route — React reconciles in place; only the contents
 * inside the sidebar and main swap when the pathname changes.
 *
 * The sidebar socket lives one level above this component, in
 * `ChatListProvider`, so it survives every transition too (including
 * `/admin` and `/settings`).
 */

// ---------------------------------------------------------------------------
// useAppShell — context published to right panes for mobile menu / expand
// ---------------------------------------------------------------------------

interface AppShellContextValue {
  openSidebar: () => void;
  expandDesktopSidebar: () => void;
  desktopCollapsed: boolean;
  compactMode: "minimal" | "strip";
  isMobile: boolean;
  level: 0 | 1 | 2;
  goBack: () => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext);
  if (!ctx) {
    throw new Error("useAppShell must be used inside <AppShell>");
  }
  return ctx;
}

/**
 * Tiny header strip with the mobile hamburger + desktop "expand sidebar" arrow.
 * Extracted so right panes that want custom chrome (e.g. the homepage banner)
 * can position their own content beneath it. Consumes `useAppShell()` — no
 * props needed.
 */
export function AppShellMobileBar() {
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode, isMobile, level, goBack } =
    useAppShell();
  if (isMobile && level >= 1) {
    return (
      <div className="flex items-center px-2 pt-[var(--sat)]">
        <button type="button" onClick={goBack} className="rounded-md p-2.5 hover:bg-panel2 transition" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>
    );
  }
  const showExpand = desktopCollapsed && compactMode === "minimal";
  if (!showExpand) {
    return (
      <div className="md:hidden flex items-center px-2 pt-[var(--sat)]">
        <button
          type="button"
          onClick={openSidebar}
          className="rounded-md p-1.5 hover:bg-panel2 transition"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-2 pt-[var(--sat)]">
      <button
        type="button"
        onClick={openSidebar}
        className="rounded-md p-1.5 hover:bg-panel2 transition md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={expandDesktopSidebar}
        className="hidden md:flex shrink-0 rounded-md p-1.5 hover:bg-panel2 transition"
        title="Expand sidebar"
      >
        <PanelLeftOpen className="h-5 w-5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public route detection (folded in from former RootShell)
// ---------------------------------------------------------------------------

const PUBLIC_PREFIXES = ["/login", "/register", "/auth/", "/docs/"];

function isPublic(path: string): boolean {
  for (const p of PUBLIC_PREFIXES) {
    if (path === p || path.startsWith(p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Admin panel routing (preserved from previous AppShell)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cold-boot restore flag keys (preserved from previous AppShell)
// ---------------------------------------------------------------------------

const COLD_BOOT_FLAG = "lc-spa-mounted";
const LAST_TOPIC_KEY = "lc-last-topic";

// ---------------------------------------------------------------------------
// Route resolution — produces (sidebarVariant, sidebarContent, sidebarHidden,
// mainContent) for the persistent shell to render. The outer JSX shape stays
// constant across every authed route; only these four slots vary.
// ---------------------------------------------------------------------------

interface ResolvedRoute {
  sidebarVariant: "chat" | "admin";
  sidebarHidden: boolean;
  sidebarContent: React.ReactNode;
  mainContent: React.ReactNode;
}

function normalizePath(rawPath: string): string {
  return rawPath.length > 1 && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
}

function resolveAuthedRoute(
  path: string,
  pathnameForChatList: string,
  permissions: string[],
): ResolvedRoute {
  const chatSidebar = <ChatListPane activeHref={pathnameForChatList} />;
  const chatBase = {
    sidebarVariant: "chat" as const,
    sidebarHidden: false,
    sidebarContent: chatSidebar,
  };

  if (path === "/" || path === "") {
    return { ...chatBase, mainContent: <HomeRightPane /> };
  }
  if (path === "/c") {
    return { ...chatBase, mainContent: <DMListView /> };
  }
  if (path === "/settings") {
    return {
      sidebarVariant: "chat",
      sidebarHidden: true,
      sidebarContent: null,
      mainContent: <SettingsView />,
    };
  }
  if (path === "/admin") {
    return {
      sidebarVariant: "admin",
      sidebarHidden: false,
      sidebarContent: <AdminNav permissions={permissions} />,
      mainContent: (
        <div className="selectable flex flex-1 flex-col overflow-y-auto pt-[calc(3.5rem+var(--sat))] md:pt-0">
          {renderAdminPanel("overview")}
        </div>
      ),
    };
  }
  if (path.startsWith("/t/")) {
    const slug = path.slice(3).split("/")[0] || "";
    return { ...chatBase, mainContent: <TopicRightPane slug={slug} /> };
  }
  if (path === "/c/new") {
    // First-message compose UI — no conversation row exists yet. Read peer
    // id from `?peer=` inside the view; see DmComposeNewView.
    return { ...chatBase, mainContent: <DmComposeNewView /> };
  }
  if (path.startsWith("/c/")) {
    const id = path.slice(3).split("/")[0] || "";
    return { ...chatBase, mainContent: <DmRightPane id={id} /> };
  }
  if (path.startsWith("/admin/")) {
    const sub = path.slice(7).split("/")[0] as AdminPanelKey;
    const key = ADMIN_PANELS.has(sub) ? sub : null;
    return {
      sidebarVariant: "admin",
      sidebarHidden: false,
      sidebarContent: <AdminNav permissions={permissions} />,
      mainContent: (
        <div className="selectable flex flex-1 flex-col overflow-y-auto pt-[calc(3.5rem+var(--sat))] md:pt-0">
          {renderAdminPanel(key)}
        </div>
      ),
    };
  }
  // Authed but unmatched — keep the chat sidebar mounted and put a 404 in main.
  return { ...chatBase, mainContent: <NotFoundPanel /> };
}

// ---------------------------------------------------------------------------
// AppShell — the persistent outer container
// ---------------------------------------------------------------------------

export function AppShell({ children }: { children?: React.ReactNode }) {
  const rawPathname = usePathname() ?? "/";
  const path = normalizePath(rawPathname);
  const router = useRouter();
  const coldBootHandledRef = useRef(false);

  const isPublicPath = isPublic(path);
  const isMobile = useIsMobile();
  const searchParams = useSearchParams();
  const hasThread = !!searchParams?.get("thread");
  const level = routeLevel(path, hasThread);
  const goBack = useCallback(() => {
    if (typeof window === "undefined") { router.push(backTarget(path)); return; }
    // ponytail: Navigation API canGoBack is false on cold deep-links even when
    // history.length > 1 (browser's initial about:blank counts). Fallback to
    // history.length check only when the Navigation API is absent.
    const nav = (window as Window & { navigation?: { canGoBack?: boolean } }).navigation;
    if (nav ? nav.canGoBack : window.history.length > 2) router.back();
    else router.push(backTarget(path));
  }, [router, path]);

  // ── ChatList context — provider lives above, always available ────────────
  const { me, meStatus, chatList, chatListStatus } = useChatListContext();

  // ── Sidebar state (mobile overlay + desktop collapsed + compact mode) ────
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { collapsed: desktopCollapsed, toggle, expand } = useSidebarCollapse();
  const [compactMode] = useState<"minimal" | "strip">(() =>
    typeof document !== "undefined"
      ? ((document.documentElement.dataset.sidebarCompact as
          | "minimal"
          | "strip") || "minimal")
      : "minimal",
  );

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const contextValue = useMemo<AppShellContextValue>(
    () => ({
      openSidebar,
      expandDesktopSidebar: expand,
      desktopCollapsed,
      compactMode,
      isMobile,
      level,
      goBack,
    }),
    [openSidebar, expand, desktopCollapsed, compactMode, isMobile, level, goBack],
  );

  // ── Backward-compat: `/dm` → `/c` ────────────────────────────────────────
  useEffect(() => {
    if (rawPathname === "/dm") {
      router.replace("/c");
      return;
    }
    if (rawPathname.startsWith("/dm/")) {
      router.replace(`/c/${rawPathname.slice(4)}`);
    }
  }, [rawPathname, router]);

  // ── Cold-boot restore: jump to last topic (or most-recent chat) on first
  //    `/` visit ──────────────────────────────────────────────────────────
  // Waits for the chat list so the no-remembered-topic case can land on the
  // most-recent conversation instead of the empty welcome pane — an installed
  // app cold-opens on content, not a blank panel. Render shows the splash
  // until chatList is ready anyway, so the slightly later redirect is unseen.
  // Home stays reachable: the cold-boot flag is set on the first run, so warm
  // Home clicks within the session never redirect.
  useEffect(() => {
    if (coldBootHandledRef.current) return;
    if (chatListStatus !== "ready" || !chatList) return;
    if (isMobile) { coldBootHandledRef.current = true; return; } // mobile lands on list root
    coldBootHandledRef.current = true;
    try {
      if (sessionStorage.getItem(COLD_BOOT_FLAG)) return;
      sessionStorage.setItem(COLD_BOOT_FLAG, "1");
      if (rawPathname !== "/" && rawPathname !== "") return;
      const last = localStorage.getItem(LAST_TOPIC_KEY);
      if (last) {
        router.replace(`/t/${last}`);
        return;
      }
      const items = chatList.chatItems;
      const recent = items.reduce<(typeof items)[number] | null>(
        (best, it) => (!best || (it.lastAt ?? "") > (best.lastAt ?? "") ? it : best),
        null,
      );
      if (recent) router.replace(recent.href);
    } catch {
      // SessionStorage / localStorage may throw in privacy modes — best-effort.
    }
  }, [rawPathname, router, chatListStatus, chatList, isMobile]);

  // ── Auto-close the mobile sidebar overlay on navigation ──────────────────
  useEffect(() => {
    setSidebarOpen(false);
  }, [rawPathname]);

  // ── On-screen keyboard inset (content only — never the header) ────────────
  // The shell is `position: fixed; inset: 0` (see container below): it fills the
  // real viewport (no `100dvh` home-indicator chin), and since <body> is
  // overflow:hidden there's nothing to scroll, so the header can never be pushed
  // off-screen — it's rock-solid with zero JS touching it (no flicker).
  // The only adjustment is lifting the *content's* bottom by the keyboard height
  // (--kb) so the composer clears the keyboard. iOS reports the keyboard by
  // shrinking visualViewport while innerHeight stays full; platforms that honour
  // interactiveWidget=resizes-content shrink innerHeight too, leaving --kb≈0
  // (the shell already shrank) — correct either way.
  useEffect(() => {
    if (isPublicPath) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let raf = 0;
    function apply() {
      raf = 0;
      const kb = Math.max(0, window.innerHeight - vv!.height - vv!.offsetTop);
      if (kb > 80) root.style.setProperty("--kb", `${kb}px`);
      else root.style.removeProperty("--kb");
    }
    function update() {
      if (!raf) raf = requestAnimationFrame(apply);
    }
    apply();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb");
    };
  }, [isPublicPath]);

  // ── General auth gate for authed routes ──────────────────────────────────
  useEffect(() => {
    if (isPublicPath) return;
    if (meStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [isPublicPath, meStatus]);

  // ── Admin perm gate ──────────────────────────────────────────────────────
  const isAdminRoute = path === "/admin" || path.startsWith("/admin/");
  useEffect(() => {
    if (!isAdminRoute) return;
    if (meStatus !== "authenticated" || !me) return;
    const hasModReview = me.permissions.includes(
      PERMISSIONS.MODERATION_QUEUE_REVIEW,
    );
    const hasAdminConfig = me.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
    if (!hasModReview && !hasAdminConfig) {
      window.location.replace("/");
    }
  }, [isAdminRoute, meStatus, me]);

  // ── Public short-circuit ─────────────────────────────────────────────────
  if (isPublicPath) {
    return <>{children}</>;
  }

  // ── Wait for both /api/me and /api/chat-list before painting ─────────────
  if (
    meStatus === "unauthenticated" ||
    !me ||
    chatListStatus !== "ready" ||
    !chatList
  ) {
    return <PWASplash />;
  }

  // ── Admin perm hard-gate (renders splash while redirect effect runs) ─────
  if (isAdminRoute) {
    const hasModReview = me.permissions.includes(
      PERMISSIONS.MODERATION_QUEUE_REVIEW,
    );
    const hasAdminConfig = me.permissions.includes(PERMISSIONS.ADMIN_CONFIG);
    if (!hasModReview && !hasAdminConfig) {
      return <PWASplash />;
    }
  }

  const chatItems = chatList.chatItems;
  const sidebarUser = {
    id: me.id,
    displayName: me.displayName,
    avatarUrl: me.avatarUrl,
    role: me.role,
    permissions: me.permissions,
    presenceOptOut: me.presenceOptOut,
  };

  // Strip-mode icon column: small thumbnails for each chat item. Only built
  // for chat-variant sidebars; admin uses the AdminNav strip handled by
  // AppSidebar itself.
  const route = resolveAuthedRoute(path, rawPathname, me.permissions);
  const iconChildren =
    route.sidebarVariant === "chat" ? (
      <div className="flex flex-col items-center gap-1 py-1">
        {chatItems.map((it) => {
          const url = it.avatar.url ?? it.avatar.iconUrl ?? null;
          return (
            <Link
              key={`${it.kind}:${it.id}`}
              href={it.href}
              title={it.title}
              className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel2 hover:bg-panel text-sm font-bold transition"
            >
              {url ? (
                <img
                  src={url}
                  alt=""
                  className="h-full w-full object-cover rounded-lg"
                />
              ) : it.kind === "topic" ? (
                <Hash className="h-4 w-4 text-muted" />
              ) : (
                it.title.slice(0, 1).toUpperCase()
              )}
            </Link>
          );
        })}
      </div>
    ) : null;

  markSpaPainted();

  return (
    <AppShellContext.Provider value={contextValue}>
      {/* Fills the layout viewport. Note: on iOS standalone this stops at the
          home-indicator safe-area boundary (the residual "chin" below) — that's
          an OS limitation for fixed elements, not something we can paint over
          reliably. Header sticks because nothing scrolls; keyboard handled via
          --kb on <main> below. */}
      <div className="fixed inset-0 flex overflow-hidden">
        {isMobile ? (
          <MobileStack level={level}>
            {level === 0 ? (
              <AppSidebar
                user={sidebarUser}
                variant={route.sidebarVariant}
                hidden={false}
                mobileFullScreen
                desktopCollapsed={false}
                compactMode={compactMode}
                iconChildren={iconChildren}
              >
                <Suspense fallback={null}>{route.sidebarContent}</Suspense>
              </AppSidebar>
            ) : (
              <main
                className="relative flex flex-1 min-w-0 flex-col overflow-hidden"
                style={{ paddingBottom: "var(--kb, 0px)" }}
              >
                <Suspense fallback={null}>{route.mainContent}</Suspense>
              </main>
            )}
          </MobileStack>
        ) : (
          <>
            <AppSidebar
              user={sidebarUser}
              variant={route.sidebarVariant}
              hidden={route.sidebarHidden}
              isOpen={false}
              onClose={() => {}}
              desktopCollapsed={desktopCollapsed}
              onToggleDesktop={toggle}
              compactMode={compactMode}
              iconChildren={iconChildren}
            >
              <Suspense fallback={null}>{route.sidebarContent}</Suspense>
            </AppSidebar>
            <main
              className="relative flex flex-1 min-w-0 flex-col overflow-hidden"
              style={{ paddingBottom: "var(--kb, 0px)" }}
            >
              <Suspense fallback={null}>{route.mainContent}</Suspense>
            </main>
          </>
        )}
      </div>
    </AppShellContext.Provider>
  );
}
