"use client";

import { useEffect } from "react";
import { HomeLayout } from "@/components/HomeLayout";
import { PWASplash } from "@/components/PWASplash";
import { useMe } from "@/lib/hooks/use-me";
import { useChatList } from "@/lib/hooks/use-chat-list";

export function HomeClient() {
  const { me, status: meStatus } = useMe();
  const { data, status: listStatus } = useChatList();

  useEffect(() => {
    if (meStatus === "unauthenticated") {
      window.location.replace("/login");
    }
  }, [meStatus]);

  useEffect(() => {
    if (listStatus === "ready" && data?.homeTopicSlug) {
      window.location.replace(`/t/${data.homeTopicSlug}`);
    }
  }, [listStatus, data?.homeTopicSlug]);

  if (
    meStatus === "loading" ||
    meStatus === "unauthenticated" ||
    listStatus === "loading" ||
    !me ||
    !data ||
    data.homeTopicSlug
  ) {
    return <PWASplash />;
  }

  return (
    <HomeLayout
      communityName={data.communityName}
      communityBannerUrl={data.communityBannerUrl}
      bannerConfig={data.bannerConfig}
      user={{
        id: me.id,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        role: me.role,
        permissions: me.permissions,
        presenceOptOut: me.presenceOptOut,
      }}
      chatItems={data.chatItems}
    />
  );
}
