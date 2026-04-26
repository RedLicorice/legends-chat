"use client";

import { useState } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { TopicListItem } from "@/components/TopicListItem";
import { PushSetup } from "@/components/PushSetup";
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
}

export function HomeLayout({ user, topics }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      <PushSetup />
      <AppSidebar
        user={user}
        variant="chat"
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      >
        <div className="space-y-0.5">
          {topics.map((t) => (
            <TopicListItem key={t.id} topic={t} compact />
          ))}
        </div>
      </AppSidebar>
      <main className="relative flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-xl py-4 px-3">
          <div className="mb-4 px-1">
            <h1 className="text-xl font-semibold">Topics</h1>
            <p className="text-sm text-muted">{topics.length} channel{topics.length === 1 ? "" : "s"}</p>
          </div>
          {topics.length === 0 ? (
            <div className="p-8 text-center text-muted">No topics yet. Ask an admin to create one.</div>
          ) : (
            topics.map((t) => <TopicListItem key={t.id} topic={t} />)
          )}
        </div>
      </main>
    </div>
  );
}
