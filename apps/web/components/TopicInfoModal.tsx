"use client";

import { X } from "lucide-react";
import { useTopicHashtags } from "@/hooks/useTopicHashtags";
import { useSymbols } from "@/contexts/SymbolsContext";
import type { Socket } from "socket.io-client";

interface Props {
  topic: {
    id: string;
    title: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
  };
  socket: Socket | null;
  onClose: () => void;
  onHashtagFilter: (tag: string) => void;
}

export function TopicInfoModal({ topic, socket, onClose, onHashtagFilter }: Props) {
  const initials = topic.title.slice(0, 1).toUpperCase();
  const { tags } = useTopicHashtags(topic.id, socket);
  const { getSymbol } = useSymbols();

  function handleTagClick(tag: string) {
    onClose();
    onHashtagFilter(tag);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-panel shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 bg-black/40 text-white/80 hover:bg-black/60 transition"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Banner */}
        <div className="relative h-32 bg-panel2">
          {topic.bannerUrl ? (
            <img src={topic.bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-accent/30 to-accent2/20" />
          )}
          {/* Icon overlapping the banner */}
          <div className="absolute -bottom-8 left-5 h-16 w-16 overflow-hidden rounded-xl border-2 border-panel bg-panel2 shadow-lg">
            {topic.iconUrl ? (
              <img src={topic.iconUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-text">
                {initials}
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-5 pb-5 pt-11">
          <h2 className="text-lg font-semibold">{topic.title}</h2>
          {topic.description ? (
            <p className="mt-1 text-sm text-muted leading-relaxed">{topic.description}</p>
          ) : (
            <p className="mt-1 text-sm text-muted italic">No description.</p>
          )}

          {/* Tag cloud */}
          {tags.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted uppercase tracking-wide">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map(({ tag }) => {
                  const isSymbol = tag.startsWith("$");
                  const sym = isSymbol ? getSymbol(tag.slice(1)) : null;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleTagClick(tag)}
                      className={[
                        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-mono transition",
                        isSymbol
                          ? "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                          : "bg-panel2 text-muted hover:bg-border hover:text-text",
                      ].join(" ")}
                    >
                      {sym?.linkedUserAvatarUrl && (
                        <img
                          src={sym.linkedUserAvatarUrl}
                          alt=""
                          className="h-3.5 w-3.5 rounded-full object-cover"
                        />
                      )}
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {tags.length === 0 && (
            <p className="mt-4 text-xs text-muted">No tags yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
