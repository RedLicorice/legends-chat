"use client";

import { useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TopicListItem } from "@/components/TopicListItem";
import { TopicView } from "@/components/TopicView";
import { EmailLinkBanner } from "@/components/EmailLinkBanner";
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
  giphyEnabled?: boolean;
}

export function TopicLayout({ user, topics, currentSlug, topic, mute, hasEmail, giphyEnabled }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connected, setConnected] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      <AppSidebar
        user={user}
        variant="chat"
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      >
        <div className="space-y-0.5">
          {topics.map((t) => (
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
        {!hasEmail && <EmailLinkBanner />}
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
        />
      </main>
    </div>
  );
}
