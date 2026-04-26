"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AppSidebar } from "@/components/AppSidebar";
import { TopicListItem } from "@/components/TopicListItem";
import { TopicView } from "@/components/TopicView";
import { EmailLinkBanner } from "@/components/EmailLinkBanner";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import type { TopicListItem as TopicItem } from "@/lib/topics";

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
  currentSlug: string;
  topic: { id: string; slug: string; title: string; isE2ee: boolean; isFeed: boolean; postRoles: string[] };
  mute: { reason: string; expiresAt: string | null } | null;
  hasEmail: boolean;
  hasWallet?: boolean;
  giphyEnabled?: boolean;
}

export function TopicLayout({ user, topics: initialTopics, currentSlug, topic, mute, hasEmail, hasWallet, giphyEnabled }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [topicItems, setTopicItems] = useState<TopicItem[]>(initialTopics);

  const handleSidebarUpdate = useCallback((update: { topicId: string; preview: string; senderName: string | null; at: string }) => {
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
        unreadCount: topic.id === update.topicId ? 0 : t.unreadCount + 1,
      };
    }));
  }, [topic.id]);

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
            <div key={t.id} className={currentSlug === t.slug ? "opacity-100" : "opacity-90"}>
              <TopicListItem
                topic={t}
                compact
                connectionStatus={currentSlug === t.slug ? (connected ? "connected" : "connecting") : undefined}
              />
            </div>
          ))}
        </div>
      </AppSidebar>
      <main className="relative flex flex-1 flex-col overflow-hidden">
        {!hasEmail && !hasWallet && <EmailLinkBanner />}
        <TopicView
          topic={topic}
          currentUser={{
            id: user.id,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            role: user.role,
            presenceOptOut: user.presenceOptOut ?? false,
            permissions: user.permissions,
          }}
          mute={mute}
          giphyEnabled={giphyEnabled}
          onMenuOpen={() => setSidebarOpen(true)}
          onConnectionChange={setConnected}
          showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
          onExpandSidebar={expand}
          onSidebarUpdate={handleSidebarUpdate}
        />
      </main>
    </div>
  );
}
