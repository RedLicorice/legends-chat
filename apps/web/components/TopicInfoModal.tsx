"use client";

import { X } from "lucide-react";

interface Props {
  topic: {
    title: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
  };
  onClose: () => void;
}

export function TopicInfoModal({ topic, onClose }: Props) {
  const initials = topic.title.slice(0, 1).toUpperCase();

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
        </div>
      </div>
    </div>
  );
}
