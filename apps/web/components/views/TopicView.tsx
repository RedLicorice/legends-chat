"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { TopicLayout } from "@/components/TopicLayout";
import { PWASplash } from "@/components/PWASplash";
import { useTopic } from "@/lib/hooks/use-topic";

export function TopicView({ slug }: { slug: string | undefined }) {
  const searchParams = useSearchParams();
  const highlightMessageId = searchParams?.get("msg") ?? undefined;

  const { data, status } = useTopic(slug);

  useEffect(() => {
    if (status === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [status]);

  if (status === "loading" || status === "unauthenticated" || !slug) {
    return <PWASplash />;
  }

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

  if (status === "error" || !data) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted">Failed to load this topic. Try refreshing.</p>
      </div>
    );
  }

  return (
    <TopicLayout
      user={data.user}
      chatItems={data.chatItems}
      currentSlug={slug}
      topic={data.topic}
      mute={data.mute}
      hasPasskey={data.hasPasskey}
      giphyEnabled={data.giphyEnabled}
      communityName={data.communityName}
      communityIconUrl={data.communityIconUrl}
      highlightMessageId={highlightMessageId}
      canPost={data.canPost}
      canReply={data.canReply}
    />
  );
}
