"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppSidebar } from "@/components/AppSidebar";
import { TopicListItem } from "@/components/TopicListItem";
import { TopicView } from "@/components/TopicView";
import { P2PView } from "@/components/P2PView";
import { PasskeyBanner } from "@/components/PasskeyBanner";
import { TopicPasswordGate } from "@/components/TopicPasswordGate";
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
  topic: { id: string; slug: string; title: string; isE2ee: boolean; isP2p: boolean; p2pFallbackE2ee: boolean; isFeed: boolean; postRoles: string[]; replyRoles: string[]; iconUrl: string | null; bannerUrl: string | null; description: string | null; hasPassword: boolean; passwordVersion: number; passwordReentryDays: number };
  mute: { reason: string; expiresAt: string | null } | null;
  hasPasskey: boolean;
  giphyEnabled?: boolean;
  communityName?: string | null;
  communityIconUrl?: string | null;
  highlightMessageId?: string;
  canPost: boolean;
  canReply: boolean;
}

export function TopicLayout({ user, topics: initialTopics, currentSlug, topic, mute, hasPasskey, giphyEnabled, communityName, communityIconUrl, highlightMessageId, canPost, canReply }: Props) {
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

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    // Track the tallest height seen — significant drop means keyboard is open.
    // Use removeProperty when no keyboard so CSS fallback (100dvh) applies,
    // avoiding the iOS gap where visualViewport.height < 100dvh at rest.
    let maxH = vv.height;
    function update() {
      maxH = Math.max(maxH, vv!.height);
      if (maxH - vv!.height > 80) {
        root.style.setProperty('--vvh', `${vv!.height}px`);
        root.style.setProperty('--vvy', `${vv!.offsetTop}px`);
      } else {
        root.style.removeProperty('--vvh');
        root.style.removeProperty('--vvy');
      }
    }
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvy');
    };
  }, []);

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
    <div className="fixed left-0 right-0 flex overflow-hidden" style={{ top: 'var(--vvy)', height: 'var(--vvh)' }}>
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
                canAdmin={user.permissions.includes("admin.config")}
              />
            </div>
          ))}
        </div>
      </AppSidebar>
      <main className="relative flex flex-1 min-w-0 flex-col overflow-x-hidden">
        {!hasPasskey && <PasskeyBanner />}
        <TopicPasswordGate
          topicId={topic.id}
          topicTitle={topic.title}
          topicIconUrl={topic.iconUrl}
          hasPassword={topic.hasPassword}
          passwordVersion={topic.passwordVersion}
          passwordReentryDays={topic.passwordReentryDays}
          isAdmin={user.role === "admin"}
        >
          {topic.isP2p ? (
            <P2PView
              topic={{ id: topic.id, slug: topic.slug, title: topic.title, isE2ee: topic.isE2ee, p2pFallbackE2ee: topic.p2pFallbackE2ee }}
              currentUser={{ id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, role: user.role }}
              onMenuOpen={() => setSidebarOpen(true)}
              showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
              onExpandSidebar={expand}
            />
          ) : (
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
              communityName={communityName}
              communityIconUrl={communityIconUrl}
              highlightMessageId={highlightMessageId}
              onMenuOpen={() => setSidebarOpen(true)}
              onConnectionChange={setConnected}
              showExpandSidebar={desktopCollapsed && compactMode === "minimal"}
              onExpandSidebar={expand}
              onSidebarUpdate={handleSidebarUpdate}
              canPost={canPost}
              canReply={canReply}
            />
          )}
        </TopicPasswordGate>
      </main>
    </div>
  );
}
