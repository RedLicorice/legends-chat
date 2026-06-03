"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Menu, PanelLeftOpen, Hash } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { ChatListPane } from "@/components/ChatListPane";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import type { ChatItem } from "@/components/ChatListItem";

interface ChatLayoutUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  permissions: string[];
  presenceOptOut?: boolean;
}

interface Props {
  user: ChatLayoutUser;
  /** Server-rendered initial snapshot for the unified sidebar list. */
  chatItems: ChatItem[];
  /**
   * Optional current route used to highlight the active row in the sidebar
   * (e.g. `/t/general`, `/dm/abc`). Defaults to `undefined` (no highlight).
   */
  activeHref?: string;
  /** Right-pane content (page body). */
  children: React.ReactNode;
}

/**
 * Unified app shell used by `/`, `/t/[slug]`, and `/dm/[id]`.
 *
 * Renders the global AppSidebar with the merged ChatListPane on the left and
 * delegates the right pane entirely to `children`. ChatListPane owns its own
 * socket subscriptions (SIDEBAR_UPDATE, DM_NEW, dm:conversation:updated), so
 * this layout only listens for the `chatlist:refresh` window event to call
 * `router.refresh()` and re-fetch `chatItems` server-side.
 */
export function ChatLayout({ user, chatItems, activeHref, children }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { collapsed: desktopCollapsed, toggle, expand } = useSidebarCollapse();

  // Auto-close the mobile sidebar on navigation. AppSidebar is desktop-static
  // (always visible at >=md), so this only affects the mobile overlay — when
  // a user taps a chat row, the overlay collapses and the thread is visible.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  const [compactMode] = useState<"minimal" | "strip">(() =>
    typeof document !== "undefined"
      ? ((document.documentElement.dataset.sidebarCompact as "minimal" | "strip") || "minimal")
      : "minimal",
  );

  // ChatListPane dispatches `chatlist:refresh` when the server snapshot needs
  // re-fetching (e.g. an accept/decline landed for a conversation we don't yet
  // have in the list). router.refresh() re-runs the server component and the
  // new chatItems flow back in via props.
  useEffect(() => {
    const onRefresh = () => router.refresh();
    window.addEventListener("chatlist:refresh", onRefresh);
    return () => window.removeEventListener("chatlist:refresh", onRefresh);
  }, [router]);

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
              <img src={url} alt="" className="h-full w-full object-cover rounded-lg" />
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
    <div className="fixed inset-0 flex overflow-hidden">
      <AppSidebar
        user={user}
        variant="chat"
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        desktopCollapsed={desktopCollapsed}
        onToggleDesktop={toggle}
        compactMode={compactMode}
        iconChildren={iconChildren}
      >
        <ChatListPane
          initialItems={chatItems}
          currentUserId={user.id}
          activeHref={activeHref}
        />
      </AppSidebar>
      <main className="relative flex flex-1 min-w-0 flex-col overflow-hidden">
        <ChatLayoutMobileBar
          onOpen={() => setSidebarOpen(true)}
          desktopCollapsed={desktopCollapsed}
          compactMode={compactMode}
          onExpand={expand}
        />
        <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden">
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * Tiny header strip with the mobile hamburger + desktop "expand sidebar" arrow.
 * Extracted so pages that want a custom right-pane chrome (e.g. the homepage
 * banner) can position their own content beneath it.
 */
function ChatLayoutMobileBar({
  onOpen,
  desktopCollapsed,
  compactMode,
  onExpand,
}: {
  onOpen: () => void;
  desktopCollapsed: boolean;
  compactMode: "minimal" | "strip";
  onExpand: () => void;
}) {
  const showExpand = desktopCollapsed && compactMode === "minimal";
  if (!showExpand) {
    // Mobile-only hamburger; desktop renders nothing so the page owns the chrome.
    return (
      <div className="md:hidden flex items-center px-2 pt-[var(--sat)]">
        <button
          type="button"
          onClick={onOpen}
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
        onClick={onOpen}
        className="rounded-md p-1.5 hover:bg-panel2 transition md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={onExpand}
        className="hidden md:flex shrink-0 rounded-md p-1.5 hover:bg-panel2 transition"
        title="Expand sidebar"
      >
        <PanelLeftOpen className="h-5 w-5" />
      </button>
    </div>
  );
}
