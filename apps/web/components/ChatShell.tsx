"use client";

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, PanelLeftOpen, Hash } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { ChatListPane } from "@/components/ChatListPane";
import { PWASplash } from "@/components/PWASplash";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";

/**
 * Single stable shell that wraps every chat-shaped route (`/`, `/t/<slug>`,
 * `/dm`, `/dm/<id>`). AppShell renders ONE `<ChatShell>` element across all
 * those paths and swaps only its children, so React keeps the sidebar +
 * ChatListPane + its socket mounted. Per-path right panes consume
 * `useChatShell()` for hamburger / expand controls instead of receiving the
 * mobile bar from above.
 */

interface ChatShellContextValue {
  openSidebar: () => void;
  expandDesktopSidebar: () => void;
  desktopCollapsed: boolean;
  compactMode: "minimal" | "strip";
}

const ChatShellContext = createContext<ChatShellContextValue | null>(null);

export function useChatShell(): ChatShellContextValue {
  const ctx = useContext(ChatShellContext);
  if (!ctx) {
    throw new Error("useChatShell must be used inside <ChatShell>");
  }
  return ctx;
}

interface Props {
  children: React.ReactNode;
}

export function ChatShell({ children }: Props) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { me, status: meStatus } = useMe();
  const { data: chatList, status: chatListStatus } = useChatList();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { collapsed: desktopCollapsed, toggle, expand } = useSidebarCollapse();
  const [compactMode] = useState<"minimal" | "strip">(() =>
    typeof document !== "undefined"
      ? ((document.documentElement.dataset.sidebarCompact as
          | "minimal"
          | "strip") || "minimal")
      : "minimal",
  );

  // Redirect unauthenticated users — consolidated here so right panes don't
  // each duplicate this effect.
  useEffect(() => {
    if (meStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [meStatus]);

  // Auto-close the mobile sidebar overlay on navigation. AppSidebar is
  // desktop-static (always visible at >=md), so this only affects mobile.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // ChatListPane dispatches `chatlist:refresh` when it needs the server
  // snapshot rebuilt (e.g. an accept/decline arrived for a conversation we
  // don't yet have in the list). router.refresh() reruns the server tree.
  useEffect(() => {
    const onRefresh = () => router.refresh();
    window.addEventListener("chatlist:refresh", onRefresh);
    return () => window.removeEventListener("chatlist:refresh", onRefresh);
  }, [router]);

  // Visual viewport tracking — keeps `--vvh` / `--vvy` in sync so the iOS
  // keyboard layout works on every chat route, not just topic threads. The
  // outer wrapper below reads them via `style`; the CSS fallback (100dvh)
  // kicks in when the keyboard isn't open.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let maxH = vv.height;
    function update() {
      maxH = Math.max(maxH, vv!.height);
      if (maxH - vv!.height > 80) {
        root.style.setProperty("--vvh", `${vv!.height}px`);
        root.style.setProperty("--vvy", `${vv!.offsetTop}px`);
      } else {
        root.style.removeProperty("--vvh");
        root.style.removeProperty("--vvy");
      }
    }
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvy");
    };
  }, []);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);

  const contextValue = useMemo<ChatShellContextValue>(
    () => ({
      openSidebar,
      expandDesktopSidebar: expand,
      desktopCollapsed,
      compactMode,
    }),
    [openSidebar, expand, desktopCollapsed, compactMode],
  );

  // Wait for both /api/me and /api/chat-list before we paint anything — the
  // sidebar needs both. Once mounted, the module-level cache means later
  // navigations reuse the data without flicker.
  if (
    meStatus === "unauthenticated" ||
    !me ||
    chatListStatus !== "ready" ||
    !chatList
  ) {
    return <PWASplash />;
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

  // Strip-mode icon column: small thumbnails for each chat item.
  const iconChildren = (
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
  );

  return (
    <ChatShellContext.Provider value={contextValue}>
      <div
        className="fixed left-0 right-0 flex overflow-hidden"
        style={{ top: "var(--vvy)", height: "var(--vvh)" }}
      >
        <AppSidebar
          user={sidebarUser}
          variant="chat"
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          desktopCollapsed={desktopCollapsed}
          onToggleDesktop={toggle}
          compactMode={compactMode}
          iconChildren={iconChildren}
        >
          <Suspense fallback={null}>
            <ChatListPane
              initialItems={chatItems}
              currentUserId={me.id}
              activeHref={pathname}
            />
          </Suspense>
        </AppSidebar>
        <main className="relative flex flex-1 min-w-0 flex-col overflow-hidden">
          <Suspense fallback={null}>{children}</Suspense>
        </main>
      </div>
    </ChatShellContext.Provider>
  );
}

/**
 * Tiny header strip with the mobile hamburger + desktop "expand sidebar" arrow.
 * Extracted so right panes that want custom chrome (e.g. the homepage banner)
 * can position their own content beneath it. Consumes `useChatShell()` — no
 * props needed.
 */
export function ChatShellMobileBar() {
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode } =
    useChatShell();
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
