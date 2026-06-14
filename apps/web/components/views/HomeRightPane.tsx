"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { AppShellMobileBar } from "@/components/AppShell";
import { PWASplash } from "@/components/PWASplash";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";

// Read-once sessionStorage key used by ChatPane to surface "your DM request
// was declined" copy after the sender's open conversation was deleted. The
// home page is the natural landing spot — ChatPane navigates here on the
// `dm:conversation:declined` event.
const DM_DECLINED_NOTICE_KEY = "legends:dm:declined-notice";

/**
 * `/` right pane. Banner + welcome card + "no chats yet" empty state.
 *
 * AppShell upstream already gates auth + `me` + `chatList` readiness, but
 * because we also auto-redirect to a configured `homeTopicSlug`, we keep our
 * own splash until either that effect fires or we render the welcome.
 */
export function HomeRightPane() {
  const router = useRouter();
  const { me } = useMe();
  const { data, status: listStatus } = useChatList();

  // Read + clear the sessionStorage notice on mount so it shows exactly once.
  // ChatPane sets it just before navigating here when a DM request was
  // declined remotely. Wrap access in a try/catch — sessionStorage can throw
  // in privacy modes.
  const [declinedNotice, setDeclinedNotice] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = sessionStorage.getItem(DM_DECLINED_NOTICE_KEY);
      if (v) {
        setDeclinedNotice(v);
        sessionStorage.removeItem(DM_DECLINED_NOTICE_KEY);
      }
    } catch {
      // best-effort; fall through silently
    }
  }, []);

  // If the admin configured a default home topic, jump to it. Replicates the
  // effect that lived in HomeView.tsx before the shell refactor.
  useEffect(() => {
    if (listStatus === "ready" && data?.homeTopicSlug) {
      router.replace(`/t/${data.homeTopicSlug}`);
    }
  }, [router, listStatus, data?.homeTopicSlug]);

  if (!me || !data) return <PWASplash />;
  if (data.homeTopicSlug) return <PWASplash />;

  const { bannerConfig, communityBannerUrl, communityName, chatItems } = data;
  const displayName = me.displayName;

  return (
    <>
      <AppShellMobileBar />
      {declinedNotice && (
        <div
          role="status"
          className="relative z-20 mx-auto mt-3 flex w-full max-w-xl items-start gap-2 rounded-md border border-border bg-panel2 px-3 py-2 text-sm text-text shadow-sm"
        >
          <div className="flex-1">
            Your message request to{" "}
            <span className="font-medium">{declinedNotice}</span> was declined.
          </div>
          <button
            type="button"
            onClick={() => setDeclinedNotice(null)}
            className="rounded p-0.5 text-muted hover:bg-panel hover:text-text"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="relative flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden">
        {bannerConfig ? (
          <>
            <div
              className="absolute left-0 right-0 top-0 z-0 overflow-hidden"
              style={{ height: `${bannerConfig.height}px` }}
            >
              <img
                src={bannerConfig.url}
                alt=""
                className="h-full w-full object-cover"
              />
              {bannerConfig.overlayEnabled && (
                <div
                  className="absolute inset-0"
                  style={{
                    background: `rgba(0,0,0,${bannerConfig.overlayOpacity / 100})`,
                  }}
                />
              )}
              {bannerConfig.fadeEnabled && (
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(to bottom, transparent 30%, rgb(var(--ch-bg)) 100%)",
                  }}
                />
              )}
            </div>
            <div
              className="shrink-0"
              style={{
                height: `${Math.max(0, bannerConfig.height - bannerConfig.overlap)}px`,
              }}
            />
          </>
        ) : communityBannerUrl ? (
          <div className="w-full h-36 sm:h-48 shrink-0 overflow-hidden">
            <img
              src={communityBannerUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}
        <div className="relative z-10 mx-auto w-full max-w-xl py-4 px-3">
          <div className="mb-4 px-1">
            <h1 className="text-xl font-semibold">{communityName}</h1>
            <p className="text-sm text-muted">
              Welcome back, {displayName}. Pick a chat from the sidebar to get
              started.
            </p>
          </div>
          {chatItems.length === 0 && (
            <div className="p-8 text-center text-muted">
              No chats yet. Topics or DMs you join will show up here.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
