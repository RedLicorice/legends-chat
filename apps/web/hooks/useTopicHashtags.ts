import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";

export interface HashtagCloudEntry {
  tag: string;
  count: number;
}

// Initial state arrives via the per-topic TOPIC_JOIN bootstrap. Live
// HASHTAG_CLOUD_UPDATE events fold in any new tags as messages stream.
export function useTopicHashtags(
  topicId: string,
  socket: Socket | null,
  initialTags: HashtagCloudEntry[] = [],
) {
  const [tags, setTags] = useState<HashtagCloudEntry[]>(initialTags);

  useEffect(() => { setTags(initialTags); }, [initialTags]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { topicId: string; tags: string[] }) => {
      if (payload.topicId !== topicId) return;
      setTags((prev) => {
        const map = new Map(prev.map((e) => [e.tag, e.count]));
        for (const t of payload.tags) {
          map.set(t, (map.get(t) ?? 0) + 1);
        }
        return Array.from(map.entries())
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
      });
    };
    socket.on(WS_EVENTS.HASHTAG_CLOUD_UPDATE, handler);
    return () => { socket.off(WS_EVENTS.HASHTAG_CLOUD_UPDATE, handler); };
  }, [socket, topicId]);

  return { tags };
}
