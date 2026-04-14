"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Trash2, VolumeX } from "lucide-react";

interface FlagView {
  id: string;
  createdAt: string;
  reason: string;
  reporter: { id: string; displayName: string };
  message: {
    id: string;
    topicId: string;
    senderUserId: string | null;
    senderDisplayName: string | null;
    text: string;
    deletedAt: string | null;
  };
}

const DURATIONS: Array<{ label: string; seconds: number | null }> = [
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86_400 },
  { label: "7d", seconds: 7 * 86_400 },
  { label: "30d", seconds: 30 * 86_400 },
  { label: "Permanent", seconds: null },
];

export function ModerationQueue({
  flags,
  canBan,
  canMute,
}: {
  flags: FlagView[];
  canBan: boolean;
  canMute: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function act(flagId: string, body: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/admin/moderation/flags/${flagId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError((await res.text()) || "action failed");
      return;
    }
    startTransition(() => router.refresh());
  }

  async function withReasonAndDuration(
    flagId: string,
    action: "ban" | "mute",
    defaultSeconds: number | null,
  ) {
    const reason = window.prompt(`${action} reason (required, min 3 chars)`)?.trim();
    if (!reason || reason.length < 3) return;
    const durationLabel =
      window.prompt(`Duration (${DURATIONS.map((d) => d.label).join(", ")})`, "24h")?.trim() ?? "24h";
    const match = DURATIONS.find((d) => d.label.toLowerCase() === durationLabel.toLowerCase());
    const durationSeconds = match ? match.seconds : defaultSeconds;
    await act(flagId, { action, reason, durationSeconds });
  }

  if (flags.length === 0) {
    return <div className="rounded-xl border border-border bg-panel p-8 text-center text-muted">Queue is empty.</div>;
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger">{error}</div>}
      {flags.map((f) => (
        <div key={f.id} className="rounded-xl border border-border bg-panel p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">
                Reported by {f.reporter.displayName} — {new Date(f.createdAt).toLocaleString()}
              </div>
              <div className="mt-1 text-sm text-danger">Reason: {f.reason}</div>
            </div>
          </div>
          <div className="mb-4 rounded-lg border border-border bg-panel2 p-3">
            <div className="mb-1 text-xs text-muted">
              {f.message.senderDisplayName ?? "Unknown sender"} — <span className="text-muted/70">#{f.message.id}</span>
            </div>
            <div className="whitespace-pre-wrap break-words text-sm">{f.message.text}</div>
            {f.message.deletedAt && <div className="mt-2 text-xs text-muted">(already deleted)</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={pending}
              onClick={() => act(f.id, { action: "dismiss" })}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-panel2"
            >
              <Check className="h-4 w-4" /> Dismiss
            </button>
            <button
              disabled={pending}
              onClick={() => act(f.id, { action: "delete" })}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-panel2"
            >
              <Trash2 className="h-4 w-4" /> Delete message
            </button>
            {canMute && (
              <button
                disabled={pending}
                onClick={() => withReasonAndDuration(f.id, "mute", 86_400)}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-panel2"
              >
                <VolumeX className="h-4 w-4" /> Mute user
              </button>
            )}
            {canBan && (
              <button
                disabled={pending}
                onClick={() => withReasonAndDuration(f.id, "ban", 86_400)}
                className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 text-sm text-danger hover:bg-danger/20"
              >
                <Ban className="h-4 w-4" /> Ban user
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
