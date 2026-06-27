"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { ChatPane } from "@/components/ChatPane";
import { P2PView } from "@/components/P2PView";
import { PasskeyBanner } from "@/components/PasskeyBanner";
import { TopicPasswordGate } from "@/components/TopicPasswordGate";
import { PWASplash } from "@/components/PWASplash";
import { useAppShell } from "@/components/AppShell";
import { createTopicChatSource } from "@/lib/chat-source/topic";
import { createMegolmChatCrypto } from "@/lib/chat-crypto";
import { toMatrixRoomId } from "@/lib/crypto-matrix";
import { useTopicBootstrap } from "@/lib/hooks/use-topic-bootstrap";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";
import type {
  TopicBootstrapHashtag,
  TopicBootstrapMember,
} from "@legends/shared";

interface Props {
  slug: string;
}

/**
 * `/t/<slug>` right pane. Fetches topic bootstrap, gates on passkey/password,
 * and routes to either P2PView or ChatPane. The outer shell + sidebar are
 * owned by `<AppShell>` upstream — this component only renders content for
 * `<main>`.
 */
export function TopicRightPane({ slug }: Props) {
  const searchParams = useSearchParams();
  const highlightMessageId = searchParams?.get("msg") ?? undefined;

  const { data, status } = useTopicBootstrap(slug);
  const { me } = useMe();
  const { data: list } = useChatList();
  const { openSidebar, expandDesktopSidebar, desktopCollapsed, compactMode } =
    useAppShell();
  const showExpandSidebar = desktopCollapsed && compactMode === "minimal";

  if (status === "notFound") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Topic not found</h1>
        <p className="text-sm text-muted">
          This topic doesn&apos;t exist or you don&apos;t have access to it.
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
  if (status === "error" && !data) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted">
          Failed to load this topic. Try refreshing.
        </p>
      </div>
    );
  }
  // Session not ready yet (cold app boot) — AppShell shows the splash too.
  if (!me || !list) return <PWASplash />;

  // No topic data, or data still for the previous slug (the one render between
  // a slug change and the hook clearing it). Hold a spinner — never paint the
  // old thread during a switch.
  if (!data || data.topic.slug !== slug) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg">
        <Loader2 className="h-6 w-6 animate-spin text-muted" aria-label="Loading" />
      </div>
    );
  }

  return (
    <>
      {!data.hasPasskey && <PasskeyBanner />}
      <TopicPasswordGate
        topicId={data.topic.id}
        topicTitle={data.topic.title}
        topicIconUrl={data.topic.iconUrl}
        hasPassword={data.topic.hasPassword}
        passwordVersion={data.topic.passwordVersion}
        passwordReentryDays={data.topic.passwordReentryDays}
        isAdmin={me.role === "admin"}
      >
        {data.topic.isP2p ? (
          <P2PView
            key={data.topic.id}
            topic={{
              id: data.topic.id,
              slug: data.topic.slug,
              title: data.topic.title,
              isE2ee: data.topic.isE2ee,
              p2pFallbackE2ee: data.topic.p2pFallbackE2ee,
            }}
            currentUser={{
              id: me.id,
              displayName: me.displayName,
              avatarUrl: me.avatarUrl,
              role: me.role,
            }}
            onMenuOpen={openSidebar}
            showExpandSidebar={showExpandSidebar}
            onExpandSidebar={expandDesktopSidebar}
          />
        ) : (
          <TopicChatPaneHost
            key={data.topic.id}
            user={{
              id: me.id,
              displayName: me.displayName,
              avatarUrl: me.avatarUrl,
              role: me.role,
              permissions: me.permissions,
              presenceOptOut: me.presenceOptOut,
            }}
            topic={data.topic}
            mute={data.mute}
            giphyEnabled={data.giphyEnabled}
            communityName={list.communityName}
            communityIconUrl={null}
            highlightMessageId={highlightMessageId}
            onMenuOpen={openSidebar}
            showExpandSidebar={showExpandSidebar}
            onExpandSidebar={expandDesktopSidebar}
            canPost={data.canPost}
            canReply={data.canReply}
            initialMembers={data.members}
            initialHashtags={data.hashtags}
          />
        )}
      </TopicPasswordGate>
    </>
  );
}

interface TopicChatPaneHostProps {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut: boolean;
  };
  topic: {
    id: string;
    slug: string;
    title: string;
    isE2ee: boolean;
    isP2p: boolean;
    p2pFallbackE2ee: boolean;
    isFeed: boolean;
    postRoles: string[];
    replyRoles: string[];
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
    hasPassword: boolean;
    passwordVersion: number;
    passwordReentryDays: number;
  };
  mute: { reason: string; expiresAt: string | null } | null;
  giphyEnabled?: boolean;
  communityName?: string | null;
  communityIconUrl?: string | null;
  highlightMessageId?: string;
  onMenuOpen: () => void;
  showExpandSidebar: boolean;
  onExpandSidebar: () => void;
  canPost: boolean;
  canReply: boolean;
  initialMembers: TopicBootstrapMember[];
  initialHashtags: TopicBootstrapHashtag[];
}

function TopicChatPaneHost({
  user,
  topic,
  mute,
  giphyEnabled,
  communityName,
  communityIconUrl,
  highlightMessageId,
  onMenuOpen,
  showExpandSidebar,
  onExpandSidebar,
  canPost,
  canReply,
  initialMembers,
  initialHashtags,
}: TopicChatPaneHostProps) {
  const source = useMemo(
    () =>
      createTopicChatSource({
        topicId: topic.id,
        isE2ee: topic.isE2ee,
        isFeed: topic.isFeed,
      }),
    [topic.id, topic.isE2ee, topic.isFeed],
  );
  const chatCrypto = useMemo(
    () =>
      topic.isE2ee ? createMegolmChatCrypto(toMatrixRoomId(topic.id)) : null,
    [topic.id, topic.isE2ee],
  );
  return (
    <ChatPane
      user={user}
      mode={{
        kind: "topic",
        topic,
        mute,
        giphyEnabled,
        communityName,
        communityIconUrl,
        canPost,
        canReply,
        initialMembers,
        initialHashtags,
      }}
      source={source}
      chatCrypto={chatCrypto}
      highlightMessageId={highlightMessageId}
      onMenuOpen={onMenuOpen}
      showExpandSidebar={showExpandSidebar}
      onExpandSidebar={onExpandSidebar}
    />
  );
}
