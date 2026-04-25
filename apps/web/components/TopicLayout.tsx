"use client";

import { useState } from "react";
import { TopicsSidebar } from "@/components/TopicsSidebar";
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
}

export function TopicLayout({ user, topics, currentSlug, topic, mute, hasEmail }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      <TopicsSidebar
        user={user}
        topics={topics}
        currentSlug={currentSlug}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
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
          onMenuOpen={() => setSidebarOpen(true)}
        />
      </main>
    </div>
  );
}
