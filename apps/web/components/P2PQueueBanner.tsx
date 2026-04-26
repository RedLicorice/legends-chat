"use client";

import { Clock } from "lucide-react";

interface Props {
  position: number;
}

export function P2PQueueBanner({ position }: Props) {
  return (
    <div className="flex items-center gap-3 border-b border-border bg-panel2 px-4 py-2.5 text-sm">
      <Clock className="h-4 w-4 shrink-0 text-accent animate-pulse" />
      <span className="text-muted">
        Channel full — you are <strong className="text-text">#{position}</strong> in queue.
        You will be admitted automatically when a spot opens.
      </span>
    </div>
  );
}
