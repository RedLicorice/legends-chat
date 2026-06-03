"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Hash } from "lucide-react";
import { AppSidebar } from "@/components/AppSidebar";
import { ChatListPane } from "@/components/ChatListPane";
import { TopicView } from "@/components/TopicView";
import { P2PView } from "@/components/P2PView";
import { PasskeyBanner } from "@/components/PasskeyBanner";
import { TopicPasswordGate } from "@/components/TopicPasswordGate";
import { useSidebarCollapse } from "@/hooks/useSidebarCollapse";
import type { ChatItem } from "@/components/ChatListItem";

interface Props {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut?: boolean;
  };
  /** Unified topic + DM list for the left sidebar. */
  chatItems: ChatItem[];
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

export function TopicLayout({ user, chatItems, currentSlug, topic, mute, hasPasskey, giphyEnabled, communityName, communityIconUrl, highlightMessageId, canPost, canReply }: Props) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [, setConnected] = useState(false);

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

  // ChatListPane requests a refresh when it can't fully update from socket data
  // alone (e.g. a newly-accepted DM that isn't in the snapshot yet). The page
  // re-runs server-side and ships an updated `chatItems` prop.
  useEffect(() => {
    const onRefresh = () => router.refresh();
    window.addEventListener("chatlist:refresh", onRefresh);
    return () => window.removeEventListener("chatlist:refresh", onRefresh);
  }, [router]);

  const [compactMode] = useState<"minimal" | "strip">(() =>
    typeof document !== "undefined"
      ? ((document.documentElement.dataset.sidebarCompact as "minimal" | "strip") || "minimal")
      : "minimal"
  );

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
        <ChatListPane
          initialItems={chatItems}
          currentUserId={user.id}
          activeHref={`/t/${currentSlug}`}
        />
      </AppSidebar>
      <main className="relative flex flex-1 min-w-0 flex-col overflow-hidden">
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
              canPost={canPost}
              canReply={canReply}
            />
          )}
        </TopicPasswordGate>
      </main>
    </div>
  );
}
