import Link from "next/link";
import { Pin, Lock, Radio, Settings2 } from "lucide-react";
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

function StatusBadge({ isE2ee, status }: { isE2ee: boolean; status: "connecting" | "connected" }) {
  if (isE2ee) {
    return (
      <span className={`absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-panel ring-1 ring-border ${status === "connecting" ? "animate-pulse" : ""}`}>
        <Lock className="h-2.5 w-2.5 text-accent2" />
      </span>
    );
  }
  return (
    <span className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-panel ${status === "connected" ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`} />
  );
}

export function TopicListItem({
  topic,
  compact,
  connectionStatus,
  canAdmin,
}: {
  topic: Item;
  compact?: boolean;
  connectionStatus?: "connecting" | "connected";
  canAdmin?: boolean;
}) {
  if (compact) {
    return (
      <div className="group relative">
        <Link
          href={`/t/${topic.slug}`}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-panel2${canAdmin ? " pr-8" : ""}`}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel2 text-sm font-semibold">
            {topic.iconUrl
              ? <img src={topic.iconUrl} alt="" className="h-full w-full object-cover" />
              : topic.title.slice(0, 1).toUpperCase()
            }
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              {topic.isSticky && <Pin className="h-3 w-3 text-accent" />}
              {topic.isP2p && <Radio className="h-3 w-3 text-accent" />}
              {topic.isE2ee && <Lock className="h-3 w-3 text-accent2" />}
              <div className="truncate text-sm font-medium">{topic.title}</div>
              {topic.unreadCount > 0 && (
                <div className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {topic.unreadCount > 99 ? "99+" : topic.unreadCount}
                </div>
              )}
            </div>
            <div className="truncate text-xs text-muted">
              {topic.lastMessage?.preview ?? topic.description ?? ""}
            </div>
          </div>
        </Link>
        {canAdmin && (
          <Link
            href={`/admin/topics?select=${topic.id}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition hover:bg-panel group-hover:opacity-60"
            title="Topic settings"
          >
            <Settings2 className="h-3.5 w-3.5 text-muted" />
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="group relative">
      <Link
        href={`/t/${topic.slug}`}
        className={`flex items-start gap-3 rounded-xl border border-transparent px-4 py-3 transition hover:border-border hover:bg-panel2${canAdmin ? " pr-10" : ""}`}
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-panel2 text-base font-semibold">
          {topic.iconUrl
            ? <img src={topic.iconUrl} alt="" className="h-full w-full object-cover" />
            : topic.title.slice(0, 1).toUpperCase()
          }
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {topic.isSticky && <Pin className="h-3.5 w-3.5 text-accent" />}
            {topic.isP2p && <Radio className="h-3.5 w-3.5 text-accent" />}
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
      {canAdmin && (
        <Link
          href={`/admin/topics?select=${topic.id}`}
          className="absolute right-3 top-3 rounded p-0.5 opacity-0 transition hover:bg-panel group-hover:opacity-60"
          title="Topic settings"
        >
          <Settings2 className="h-4 w-4 text-muted" />
        </Link>
      )}
    </div>
  );
}
