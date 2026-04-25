"use client";

import { useCallback, useEffect, useState } from "react";

interface BanRow {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
}

export function BansPanel() {
  const [bans, setBans] = useState<BanRow[]>([]);
  const [mutes, setMutes] = useState<BanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lifting, setLifting] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/bans")
      .then((r) => r.json())
      .then((d) => {
        setBans(d.bans ?? []);
        setMutes(d.mutes ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function lift(id: string, type: "ban" | "mute") {
    setLifting(id);
    await fetch(`/api/admin/bans/${id}?type=${type}`, { method: "DELETE" });
    setLifting(null);
    load();
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-8">
      <Section
        title="Active bans"
        rows={bans}
        type="ban"
        lifting={lifting}
        onLift={lift}
      />
      <Section
        title="Active mutes"
        rows={mutes}
        type="mute"
        lifting={lifting}
        onLift={lift}
      />
    </div>
  );
}

function Section({
  title,
  rows,
  type,
  lifting,
  onLift,
}: {
  title: string;
  rows: BanRow[];
  type: "ban" | "mute";
  lifting: string | null;
  onLift: (id: string, type: "ban" | "mute") => void;
}) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">None.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-4 rounded-xl border border-border bg-panel px-4 py-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent2 text-sm font-semibold text-white">
                {r.avatarUrl ? (
                  <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  r.displayName.slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.displayName}</div>
                {r.reason && <div className="truncate text-xs text-muted">{r.reason}</div>}
                {r.expiresAt && (
                  <div className="text-xs text-muted">
                    Expires {new Date(r.expiresAt).toLocaleString()}
                  </div>
                )}
              </div>
              <button
                disabled={lifting === r.id}
                onClick={() => onLift(r.id, type)}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-panel2 disabled:opacity-50"
              >
                {lifting === r.id ? "Lifting…" : "Lift"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
