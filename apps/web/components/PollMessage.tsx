"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";

interface PollOption {
  id: string;
  text: string;
  position: number;
  voteCount: number;
}

interface PollData {
  id: string;
  question: string;
  options: PollOption[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
  isClosed: boolean;
  totalVotes: number;
}

interface Props {
  poll: PollData;
  myVotes: string[];
  isMine: boolean;
  canClose: boolean;
  onVote: (pollId: string, optionIds: string[]) => void;
  onClose: (pollId: string) => void;
}

export function PollMessage({ poll, myVotes, isMine, canClose, onVote, onClose }: Props) {
  const [selected, setSelected] = useState<string[]>(myVotes);
  const hasVoted = myVotes.length > 0;
  const showResults = hasVoted || poll.isClosed;

  const toggleOption = (optionId: string) => {
    if (poll.isClosed) return;
    if (poll.allowsMultiple) {
      setSelected((prev) =>
        prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId],
      );
    } else {
      // Single choice: vote immediately
      onVote(poll.id, [optionId]);
    }
  };

  const submitVote = () => {
    if (selected.length === 0) return;
    onVote(poll.id, selected);
  };

  const maxVotes = Math.max(...poll.options.map((o) => o.voteCount), 1);

  return (
    <div className={cn("rounded-2xl border border-border bg-panel p-4 text-sm", isMine && "border-accent/30")}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted mb-1">
            {poll.isAnonymous ? "Anonymous Poll" : "Poll"}
            {poll.allowsMultiple && " · Multiple choice"}
          </div>
          <div className="font-medium text-text leading-snug">{poll.question}</div>
        </div>
        {poll.isClosed && <Lock className="h-3.5 w-3.5 shrink-0 text-muted mt-0.5" />}
      </div>

      <div className="space-y-2">
        {poll.options.map((opt) => {
          const pct = poll.totalVotes > 0 ? Math.round((opt.voteCount / poll.totalVotes) * 100) : 0;
          const isSelected = selected.includes(opt.id) || myVotes.includes(opt.id);
          const isLeading = opt.voteCount === maxVotes && poll.totalVotes > 0;

          if (showResults) {
            return (
              <div key={opt.id} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className={cn("flex items-center gap-1.5", myVotes.includes(opt.id) && "font-medium text-accent")}>
                    {myVotes.includes(opt.id) && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                    {opt.text}
                  </span>
                  <span className="shrink-0 text-muted">{pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", isLeading ? "bg-accent" : "bg-border")}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          }

          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => toggleOption(opt.id)}
              className={cn(
                "w-full rounded-xl border px-3 py-2 text-left text-sm transition",
                isSelected
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-panel2 hover:border-accent/50 hover:bg-panel2",
              )}
            >
              {opt.text}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {poll.totalVotes} vote{poll.totalVotes !== 1 ? "s" : ""}
          {poll.isClosed && " · Closed"}
        </span>
        <div className="flex items-center gap-2">
          {!showResults && poll.allowsMultiple && !poll.isClosed && (
            <button
              type="button"
              onClick={submitVote}
              disabled={selected.length === 0}
              className="rounded-lg bg-accent px-3 py-1 text-xs text-white disabled:opacity-40 hover:opacity-90 transition"
            >
              Vote
            </button>
          )}
          {hasVoted && !poll.isClosed && (
            <button
              type="button"
              onClick={() => { setSelected([]); onVote(poll.id, []); }}
              className="text-xs text-muted hover:text-text transition"
            >
              Retract
            </button>
          )}
          {canClose && !poll.isClosed && (
            <button
              type="button"
              onClick={() => onClose(poll.id)}
              className="text-xs text-muted hover:text-danger transition"
            >
              Close poll
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
