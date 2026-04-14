import Link from "next/link";
import { Pin, Lock } from "lucide-react";
import type { TopicListItem as Item } from "@/lib/topics";

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function TopicListItem({ topic }: { topic: Item }) {
  return (
    <Link
      href={`/t/${topic.slug}`}
      className="flex items-start gap-3 rounded-xl border border-transparent px-4 py-3 transition hover:border-border hover:bg-panel2"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-panel2 text-base font-semibold">
        {topic.title.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {topic.isSticky && <Pin className="h-3.5 w-3.5 text-accent" />}
          {topic.isE2ee && <Lock className="h-3.5 w-3.5 text-accent2" />}
          <div className="truncate font-medium">{topic.title}</div>
          {topic.lastMessage && (
            <div className="ml-auto shrink-0 text-xs text-muted">{timeAgo(topic.lastMessage.at)}</div>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <div className="line-clamp-1 flex-1 text-sm text-muted">
            {topic.lastMessage?.preview ?? topic.description ?? "No messages yet"}
          </div>
          {topic.unreadCount > 0 && (
            <div className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">
              {topic.unreadCount > 99 ? "99+" : topic.unreadCount}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
