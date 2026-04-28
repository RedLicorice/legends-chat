"use client";
import { apiFetch } from "@/lib/fetch";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { cn } from "@/lib/cn";

interface ThreadMessage {
  id: string;
  topicId: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  senderIsAnon: boolean;
  botId: string | null;
  replyToMessageId: string | null;
  text: string;
  attachments: { type: string; url: string; thumbnailUrl?: string }[];
  createdAt: string | Date;
  editedAt: string | Date | null;
}

interface ThreadPanelProps {
  rootMessage: ThreadMessage;
  topicId: string;
  currentUserId: string;
  isE2ee: boolean;
  onClose: () => void;
  onReply: (messageId: string) => void;
  decryptText?: (text: string, senderId: string | null) => string;
}

function friendlyTime(date: Date | string): string {
  const d = new Date(date);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Avatar({ name, url }: { name: string | null; url: string | null }) {
  const cls = "h-7 w-7 shrink-0 rounded-full bg-accent2 overflow-hidden";
  return url ? (
    <div className={cls}><img src={url} alt="" className="h-full w-full object-cover" /></div>
  ) : (
    <div className={cn(cls, "flex items-center justify-center text-xs font-semibold text-white")}>
      {(name ?? "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ThreadPanel({
  rootMessage,
  topicId,
  currentUserId,
  isE2ee,
  onClose,
  onReply,
  decryptText,
}: ThreadPanelProps) {
  const [replies, setReplies] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch(`/api/topics/${topicId}/messages?replyTo=${rootMessage.id}`)
      .then((r) => r.json())
      .then((data) => { if (active) setReplies(Array.isArray(data) ? data : []); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [topicId, rootMessage.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies]);

  function renderText(msg: ThreadMessage): string {
    if (isE2ee && decryptText) return decryptText(msg.text, msg.senderUserId);
    return msg.text;
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-panel w-80 shrink-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Thread</span>
        <button type="button" onClick={onClose} className="text-muted hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Root message */}
      <div className="border-b border-border px-4 py-3 bg-panel2/50">
        <div className="flex gap-2 items-start">
          <Avatar name={rootMessage.senderDisplayName} url={rootMessage.senderAvatarUrl} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-semibold text-accent2">{rootMessage.senderDisplayName ?? "Unknown"}</span>
              <span suppressHydrationWarning className="text-xs text-muted">{friendlyTime(rootMessage.createdAt)}</span>
            </div>
            <div className="mt-1 text-sm">
              {isE2ee ? (
                <span className="text-muted italic">(encrypted)</span>
              ) : (
                <MarkdownContent content={rootMessage.text} className="text-sm" />
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onReply(rootMessage.id)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Reply to thread
        </button>
      </div>

      {/* Replies */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {loading ? (
          <p className="text-center text-xs text-muted py-4">Loading…</p>
        ) : replies.length === 0 ? (
          <p className="text-center text-xs text-muted py-4">No replies yet.</p>
        ) : (
          replies.map((r) => {
            const mine = r.senderUserId === currentUserId;
            const displayText = renderText(r);
            return (
              <div key={r.id} className={cn("flex gap-2 items-start", mine && "flex-row-reverse")}>
                <Avatar name={r.senderDisplayName} url={r.senderAvatarUrl} />
                <div className={cn("max-w-[80%] flex flex-col", mine && "items-end")}>
                  <div className="flex items-baseline gap-1.5 mb-1">
                    <span className="text-xs font-medium text-accent2">{r.senderDisplayName ?? "Unknown"}</span>
                    <span suppressHydrationWarning className="text-xs text-muted">{friendlyTime(r.createdAt)}</span>
                  </div>
                  <div className={cn("rounded-2xl px-3 py-2 text-sm", mine ? "bg-accent text-white" : "bg-panel2")}>
                    {isE2ee ? (
                      <span className="italic text-sm opacity-70">(encrypted)</span>
                    ) : (
                      <MarkdownContent content={displayText} className={cn("text-sm", mine && "[&_*]:text-white")} />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
