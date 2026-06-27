"use client";

import { useEffect, useRef, useState } from "react";
import { WS_EVENTS, type TopicBootstrap, type TopicBootstrapAck } from "@legends/shared";
import type { ResourceStatus } from "@/lib/hooks/use-api-resource";
import { useSessionBootstrap } from "@/contexts/SessionBootstrapContext";
import { apiFetch } from "@/lib/fetch";

// Map the WS bootstrap fields into the legacy /api/topic/[slug] payload
// shape so the rest of TopicView keeps working unchanged.
export interface TopicBootstrapPayload {
  topic: TopicBootstrap["topic"];
  mute: TopicBootstrap["mute"];
  hasPasskey: boolean;
  giphyEnabled: boolean;
  canPost: boolean;
  canReply: boolean;
  members: TopicBootstrap["members"];
  hashtags: TopicBootstrap["hashtags"];
}

export interface UseTopicBootstrapResult {
  data: TopicBootstrapPayload | null;
  status: ResourceStatus;
}

// Default path: TOPIC_JOIN ack on the shared session socket. Cold-start
// fallback: REST /api/topic/<slug> (no members/hashtags; the socket fills
// those in once it connects).
export function useTopicBootstrap(slug: string | undefined): UseTopicBootstrapResult {
  const { socket } = useSessionBootstrap();
  const [data, setData] = useState<TopicBootstrapPayload | null>(null);
  const [status, setStatus] = useState<ResourceStatus>("loading");
  const slugRef = useRef<string | undefined>(slug);
  slugRef.current = slug;
  // Tracks the slug the effect last ran for, so we can distinguish a real
  // topic switch from a socket reconnect (both re-fire the effect).
  const loadedSlugRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!slug) { setData(null); setStatus("loading"); return; }
    let cancelled = false;
    // On an actual slug change, drop the previous topic's data outright so the
    // old thread can't linger (no stale-while-revalidate flash, and the reused
    // state is gone, not just masked). On a socket reconnect (same slug) we
    // keep the data so the current topic doesn't blank out.
    if (loadedSlugRef.current !== slug) {
      setData(null);
      loadedSlugRef.current = slug;
    }
    setStatus("loading");

    async function bootstrapOverSocket() {
      if (!socket) return false;
      // Socket.io v4 emitWithAck returns a Promise that resolves with the
      // ack payload. We thread the slug straight through — the server
      // accepts slug OR id and resolves internally.
      try {
        const ack = (await socket
          .timeout(8000)
          .emitWithAck(WS_EVENTS.TOPIC_JOIN, slug)) as
          | (TopicBootstrapAck & { messages?: unknown; reactions?: unknown; onlineUserIds?: unknown; myPollVotes?: unknown })
          | undefined;
        if (cancelled || slugRef.current !== slug) return true;
        if (!ack || !("ok" in ack)) {
          setStatus("error");
          return true;
        }
        if (!ack.ok) {
          if (ack.error === "not_found") setStatus("notFound");
          else if (ack.error === "forbidden") setStatus("forbidden");
          else setStatus("error");
          return true;
        }
        setData({
          topic: ack.data.topic,
          mute: ack.data.mute,
          hasPasskey: ack.data.hasPasskey,
          giphyEnabled: ack.data.giphyEnabled,
          canPost: ack.data.canPost,
          canReply: ack.data.canReply,
          members: ack.data.members,
          hashtags: ack.data.hashtags,
        });
        setStatus("ready");
        return true;
      } catch {
        return false;
      }
    }

    // COLD START path. Hits when the socket hasn't connected yet (first
    // paint, or transient disconnect). Mirrors the legacy
    // /api/topic/<slug> shape — members + hashtags fill in once the
    // socket comes up via TOPIC_JOIN.
    async function bootstrapOverRest() {
      try {
        const r = await apiFetch(`/api/topic/${encodeURIComponent(slug!)}`);
        if (cancelled || slugRef.current !== slug) return;
        if (r.status === 404) { setStatus("notFound"); return; }
        if (r.status === 403) { setStatus("forbidden"); return; }
        if (r.status === 401) { setStatus("unauthenticated"); return; }
        if (!r.ok) { setStatus("error"); return; }
        const j = (await r.json()) as Omit<TopicBootstrapPayload, "members" | "hashtags">;
        setData({ ...j, members: [], hashtags: [] });
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void (async () => {
      const ok = await bootstrapOverSocket();
      if (!ok && !cancelled) await bootstrapOverRest();
    })();

    return () => { cancelled = true; };
  }, [slug, socket]);

  return { data, status };
}
