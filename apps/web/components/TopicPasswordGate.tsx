"use client";

import { useState, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { useTopicPassword } from "@/hooks/useTopicPassword";

interface Props {
  topicId: string;
  topicTitle: string;
  topicIconUrl: string | null;
  passwordVersion: number;
  passwordReentryDays: number;
  hasPassword: boolean;
  isAdmin: boolean;
  children: ReactNode;
}

export function TopicPasswordGate({
  topicId,
  topicTitle,
  topicIconUrl,
  passwordVersion,
  passwordReentryDays,
  hasPassword,
  isAdmin,
  children,
}: Props) {
  const { state, error, submitting, submit } = useTopicPassword({
    topicId,
    passwordVersion,
    passwordReentryDays,
    hasPassword,
    isAdmin,
  });
  const [input, setInput] = useState("");

  if (state === "checking") {
    // Avoid content flash while reading localStorage
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (state === "unlocked") {
    return <>{children}</>;
  }

  // state === "locked"
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-3">
          {topicIconUrl ? (
            <img
              src={topicIconUrl}
              alt=""
              className="h-14 w-14 rounded-xl border border-border object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-panel2 text-2xl font-bold">
              {topicTitle.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="text-center">
            <h2 className="text-lg font-semibold">{topicTitle}</h2>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted">
              <Lock className="h-3.5 w-3.5" />
              Password protected
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) submit(input);
          }}
          className="space-y-3"
        >
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter topic password"
            autoFocus
            className="w-full rounded-xl border border-border bg-panel2 px-4 py-3 text-sm outline-none focus:border-accent"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !input.trim()}
            className="w-full rounded-xl bg-accent py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
