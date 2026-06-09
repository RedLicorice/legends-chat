"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { TopicLayout } from "@/components/TopicLayout";
import { PWASplash } from "@/components/PWASplash";
import { useTopic } from "@/lib/hooks/use-topic";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";

export function TopicView({ slug }: { slug: string | undefined }) {
  const searchParams = useSearchParams();
  const highlightMessageId = searchParams?.get("msg") ?? undefined;

  const { data, status } = useTopic(slug);
  const { me, status: meStatus } = useMe();
  const { data: list } = useChatList();

  useEffect(() => {
    if (status === "unauthenticated" || meStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [status, meStatus]);

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
        <p className="text-sm text-muted">Failed to load this topic. Try refreshing.</p>
      </div>
    );
  }
  if (!data || !me || !list || !slug) return <PWASplash />;

  return (
    <TopicLayout
      user={{
        id: me.id,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        role: me.role,
        permissions: me.permissions,
        presenceOptOut: me.presenceOptOut,
      }}
      chatItems={list.chatItems}
      currentSlug={slug}
      topic={data.topic}
      mute={data.mute}
      hasPasskey={data.hasPasskey}
      giphyEnabled={data.giphyEnabled}
      communityName={list.communityName}
      communityIconUrl={null}
      highlightMessageId={highlightMessageId}
      canPost={data.canPost}
      canReply={data.canReply}
    />
  );
}
