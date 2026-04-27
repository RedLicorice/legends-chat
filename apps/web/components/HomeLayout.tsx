"use client";

import { useCallback, useEffect, useState } from "react";
import { Menu, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { io } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";
import { AppSidebar } from "@/components/AppSidebar";
import { TopicListItem } from "@/components/TopicListItem";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import type { TopicListItem as TopicItem } from "@/lib/topics";

interface BannerConfig {
  url: string;
  height: number;
  overlap: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
  fadeEnabled: boolean;
}

interface Props {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut?: boolean;
  };
  topics: TopicItem[];
  communityName?: string;
  communityBannerUrl?: string | null;
  bannerConfig?: BannerConfig | null;
}

export function HomeLayout({ user, topics: initialTopics, communityName = "Topics", communityBannerUrl, bannerConfig }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [topicItems, setTopicItems] = useState<TopicItem[]>(initialTopics);

  useEffect(() => {
    const socket = io(window.location.origin, { withCredentials: true, transports: ["polling", "websocket"] });
    socket.on(WS_EVENTS.SIDEBAR_UPDATE, (update: { topicId: string; preview: string; senderName: string | null; at: string }) => {
      setTopicItems((prev) => prev.map((t) => {
        if (t.id !== update.topicId) return t;
        return {
          ...t,
          lastMessage: {
            id: t.lastMessage?.id ?? update.topicId,
            preview: update.preview,
            at: new Date(update.at),
            senderId: null,
          },
          unreadCount: t.unreadCount + 1,
        };
      }));
    });
    return () => { socket.disconnect(); };
  }, []);

  const { collapsed: desktopCollapsed, toggle, expand } = useSidebarCollapse();

  const [compactMode] = useState<"minimal" | "strip">(() =>
    typeof document !== "undefined"
      ? ((document.documentElement.dataset.sidebarCompact as "minimal" | "strip") || "minimal")
      : "minimal"
  );

  const iconChildren = (
    <div className="flex flex-col items-center gap-1 py-1">
      {topicItems.map((t) => (
        <Link
          key={t.id}
          href={`/t/${t.slug}`}
          title={t.title}
          className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel2 hover:bg-panel text-sm font-bold transition"
        >
          {t.iconUrl ? (
            <img src={t.iconUrl} alt="" className="h-full w-full object-cover rounded-lg" />
          ) : (
            t.title.slice(0, 1).toUpperCase()
          )}
        </Link>
      ))}
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
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
        <div className="space-y-0.5">
          {topicItems.map((t) => (
            <TopicListItem key={t.id} topic={t} compact />
          ))}
        </div>
      </AppSidebar>
      <main className="relative flex flex-1 flex-col overflow-y-auto">
        {bannerConfig ? (
          <>
            {/* Banner — absolute, behind content */}
            <div
              className="absolute left-0 right-0 top-0 z-0 overflow-hidden"
              style={{ height: `${bannerConfig.height}px` }}
            >
              <img src={bannerConfig.url} alt="" className="h-full w-full object-cover" />
              {bannerConfig.overlayEnabled && (
                <div
                  className="absolute inset-0"
                  style={{ background: `rgba(0,0,0,${bannerConfig.overlayOpacity / 100})` }}
                />
              )}
              {bannerConfig.fadeEnabled && (
                <div
                  className="absolute inset-0"
                  style={{ background: "linear-gradient(to bottom, transparent 30%, rgb(var(--ch-bg)) 100%)" }}
                />
              )}
            </div>
            {/* Spacer — visible banner height minus overlap */}
            <div className="shrink-0" style={{ height: `${Math.max(0, bannerConfig.height - bannerConfig.overlap)}px` }} />
          </>
        ) : communityBannerUrl ? (
          <div className="w-full h-36 sm:h-48 shrink-0 overflow-hidden">
            <img src={communityBannerUrl} alt="" className="h-full w-full object-cover" />
          </div>
        ) : null}
        <div className="relative z-10 mx-auto w-full max-w-xl py-4 px-3">
          <div className="mb-4 px-1 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-md p-1.5 hover:bg-panel2 transition md:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            {desktopCollapsed && compactMode === "minimal" && (
              <button
                type="button"
                onClick={expand}
                className="hidden md:flex shrink-0 rounded-md p-1.5 hover:bg-panel2 transition"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="h-5 w-5" />
              </button>
            )}
            <div>
              <h1 className="text-xl font-semibold">{communityName}</h1>
              <p className="text-sm text-muted">{topicItems.length} channel{topicItems.length === 1 ? "" : "s"}</p>
            </div>
          </div>
          {topicItems.length === 0 ? (
            <div className="p-8 text-center text-muted">No topics yet. Ask an admin to create one.</div>
          ) : (
            topicItems.map((t) => <TopicListItem key={t.id} topic={t} />)
          )}
        </div>
      </main>
    </div>
  );
}
