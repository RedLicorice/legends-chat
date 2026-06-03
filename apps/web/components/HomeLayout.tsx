"use client";

import { ChatLayout } from "@/components/ChatLayout";
import type { ChatItem } from "@/components/ChatListItem";

interface BannerConfig {
  url: string;
  height: number;
  overlap: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
  fadeEnabled: boolean;
}

interface Props {
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    permissions: string[];
    presenceOptOut?: boolean;
  };
  /** Unified topic + DM list from `listChatItems`. */
  chatItems: ChatItem[];
  communityName?: string;
  communityBannerUrl?: string | null;
  bannerConfig?: BannerConfig | null;
}

/**
 * Home page (`/`) right pane. The left sidebar is now the shared ChatListPane
 * inside ChatLayout — this component owns only the banner + welcome content.
 */
export function HomeLayout({ user, chatItems, communityName = "Topics", communityBannerUrl, bannerConfig }: Props) {
  return (
    <ChatLayout user={user} chatItems={chatItems}>
      <div className="relative flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden">
        {bannerConfig ? (
          <>
            <div
              className="absolute left-0 right-0 top-0 z-0 overflow-hidden"
              style={{ height: `${bannerConfig.height}px` }}
            >
              <img src={bannerConfig.url} alt="" className="h-full w-full object-cover" />
              {bannerConfig.overlayEnabled && (
                <div
                  className="absolute inset-0"
                  style={{ background: `rgba(0,0,0,${bannerConfig.overlayOpacity / 100})` }}
                />
              )}
              {bannerConfig.fadeEnabled && (
                <div
                  className="absolute inset-0"
                  style={{ background: "linear-gradient(to bottom, transparent 30%, rgb(var(--ch-bg)) 100%)" }}
                />
              )}
            </div>
            <div className="shrink-0" style={{ height: `${Math.max(0, bannerConfig.height - bannerConfig.overlap)}px` }} />
          </>
        ) : communityBannerUrl ? (
          <div className="w-full h-36 sm:h-48 shrink-0 overflow-hidden">
            <img src={communityBannerUrl} alt="" className="h-full w-full object-cover" />
          </div>
        ) : null}
        <div className="relative z-10 mx-auto w-full max-w-xl py-4 px-3">
          <div className="mb-4 px-1">
            <h1 className="text-xl font-semibold">{communityName}</h1>
            <p className="text-sm text-muted">
              Welcome back, {user.displayName}. Pick a chat from the sidebar to get started.
            </p>
          </div>
          {chatItems.length === 0 && (
            <div className="p-8 text-center text-muted">
              No chats yet. Topics or DMs you join will show up here.
            </div>
          )}
        </div>
      </div>
    </ChatLayout>
  );
}
