"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { ModerationQueue } from "@/components/ModerationQueue";

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

interface Props {
  onClose: () => void;
}

export function ModQueueModal({ onClose }: Props) {
  const [flags, setFlags] = useState<FlagView[]>([]);
  const [canBan, setCanBan] = useState(false);
  const [canMute, setCanMute] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFlags = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/moderation/flags");
      if (!res.ok) throw new Error("failed to load");
      const data = await res.json() as { flags: FlagView[]; canBan: boolean; canMute: boolean };
      setFlags(data.flags);
      setCanBan(data.canBan);
      setCanMute(data.canMute);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFlags(); }, [fetchFlags]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex w-full max-w-2xl flex-col rounded-2xl border border-border bg-panel shadow-xl"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Moderation queue</h2>
            {!loading && !error && (
              <p className="text-xs text-muted">{flags.length} pending flag{flags.length === 1 ? "" : "s"}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-muted hover:text-text">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading && <p className="text-center text-sm text-muted">Loading…</p>}
          {error && <p className="text-center text-sm text-danger">{error}</p>}
          {!loading && !error && (
            <ModerationQueue flags={flags} canBan={canBan} canMute={canMute} onRefresh={fetchFlags} />
          )}
        </div>
      </div>
    </div>
  );
}
