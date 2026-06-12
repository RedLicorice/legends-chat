"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

export interface AdminBotsE2eeSectionProps {
  bot: {
    id: string;
    e2ee_state: "disabled" | "pending" | "ready";
    e2ee_device_id: string | null;
    identityKeyFingerprint?: string;
    lastKeysUploadAt?: string;
  };
  onChange: () => void;
}

function truncate(s: string, head = 8, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function groupFingerprint(fp: string): string {
  return fp.match(/.{1,8}/g)?.join(" ") ?? fp;
}

function humanise(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function StateBadge({ state }: { state: "disabled" | "pending" | "ready" }) {
  if (state === "disabled") {
    return <span className="rounded-full bg-panel2 px-2 py-0.5 text-xs text-muted">Disabled</span>;
  }
  if (state === "pending") {
    return (
      <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-600 dark:text-yellow-400">
        Pending bot upload
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-600 dark:text-green-400">
      Ready
    </span>
  );
}

export function AdminBotsE2eeSection({ bot, onChange }: AdminBotsE2eeSectionProps) {
  const [busy, setBusy] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const enabled = bot.e2ee_state !== "disabled";

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/bots/${bot.id}/e2ee`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-panel2/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          End-to-end encryption
        </h4>
        <StateBadge state={bot.e2ee_state} />
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
        <span>End-to-end encryption</span>
      </label>

      {bot.e2ee_device_id && (bot.e2ee_state === "ready" || bot.e2ee_state === "pending") && (
        <div className="space-y-1 text-xs text-muted">
          <div className="flex gap-2">
            <span className="w-28 shrink-0">Device:</span>
            <span data-testid="e2ee-device-id" className="font-mono">
              {truncate(bot.e2ee_device_id)}
            </span>
          </div>
          {bot.identityKeyFingerprint && (
            <div className="flex gap-2">
              <span className="w-28 shrink-0">Fingerprint:</span>
              <span data-testid="e2ee-fingerprint" className="font-mono">
                {groupFingerprint(bot.identityKeyFingerprint)}
              </span>
            </div>
          )}
          {bot.lastKeysUploadAt && (
            <div className="flex gap-2">
              <span className="w-28 shrink-0">Last upload:</span>
              <span data-testid="e2ee-last-upload">{humanise(bot.lastKeysUploadAt)}</span>
            </div>
          )}
        </div>
      )}

      {bot.e2ee_device_id && (
        <button
          type="button"
          onClick={() => setConfirmingRotate(true)}
          disabled={busy}
          className="flex items-center gap-1 rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" /> Rotate identity
        </button>
      )}

      {confirmingRotate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={cn("w-full max-w-md rounded-xl border border-border bg-panel p-5 shadow-xl")}>
            <h5 className="mb-2 text-sm font-semibold">Rotate bot E2EE identity?</h5>
            <p className="mb-4 text-xs text-muted">
              Forces the bot to wipe its local Olm pickle and bootstrap a fresh identity.
              Existing E2EE conversations with this bot will be lost.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingRotate(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setConfirmingRotate(false);
                  await patch({ rotate: true });
                }}
                className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white"
              >
                Confirm rotate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
