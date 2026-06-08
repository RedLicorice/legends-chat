"use client";

import { useEffect } from "react";
import { ChatLayout } from "@/components/ChatLayout";
import { DmThreadPane } from "@/components/DmThreadPane";
import { PWASplash } from "@/components/PWASplash";
import { useDm } from "@/lib/hooks/use-dm";

export function DMThreadView({ id }: { id: string | undefined }) {
  const { data, status } = useDm(id);

  useEffect(() => {
    if (status === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [status]);

  if ((!data && status === "loading") || status === "unauthenticated" || !id) {
    return <PWASplash />;
  }

  if (status === "notFound") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-fg">
        <h1 className="text-xl font-semibold">Conversation not found</h1>
        <p className="text-sm text-muted">
          This DM doesn&apos;t exist or you don&apos;t have access to it.
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
        <p className="text-sm text-muted">Failed to load this conversation. Try refreshing.</p>
      </div>
    );
  }

  return (
    <ChatLayout
      user={data.user}
      chatItems={data.chatItems}
      activeHref={`/dm/${id}`}
    >
      <DmThreadPane
        conversationId={id}
        currentUserId={data.user.id}
        conversation={{
          id: data.conversation.id,
          isE2ee: data.conversation.isE2ee,
          e2eeRoomId: data.conversation.e2eeRoomId,
          peer: data.conversation.peer,
        }}
      />
    </ChatLayout>
  );
}
