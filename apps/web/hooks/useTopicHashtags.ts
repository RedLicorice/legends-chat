import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";

export interface HashtagCloudEntry {
  tag: string;
  count: number;
}

export function useTopicHashtags(topicId: string, socket: Socket | null) {
  const [tags, setTags] = useState<HashtagCloudEntry[]>([]);

  const load = useCallback(() => {
    fetch(`/api/topics/${topicId}/hashtags`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: HashtagCloudEntry[]) => setTags(data))
      .catch(() => undefined);
  }, [topicId]);

  useEffect(() => {
    load();
  }, [load]);

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

  return { tags, reload: load };
}
