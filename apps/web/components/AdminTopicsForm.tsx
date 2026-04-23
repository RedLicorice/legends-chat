"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface TopicRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  isSticky: boolean;
  sortOrder: number;
  isFeed: boolean;
  isHomeTopic: boolean;
  isE2ee: boolean;
  postRoles: string[];
  readRoles: string[];
  autoDeleteMode: "none" | "age" | "count";
  autoDeleteAgeSeconds: number | null;
  autoDeleteMaxMessages: number | null;
}

const ALL_ROLES = ["user", "moderator", "admin"];

function secondsToDisplay(s: number | null): { value: string; unit: "hours" | "days" } {
  if (!s) return { value: "24", unit: "hours" };
  if (s >= 86400 && s % 86400 === 0) return { value: String(s / 86400), unit: "days" };
  return { value: String(Math.round(s / 3600)), unit: "hours" };
}

function RolesCheckboxes({
  roles,
  onSave,
  disabled,
}: {
  roles: string[];
  onSave: (roles: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {ALL_ROLES.map((role) => (
        <label key={role} className="flex items-center gap-1.5 cursor-pointer text-sm">
          <input
            type="checkbox"
            className="accent-accent"
            checked={roles.length === 0 || roles.includes(role)}
            disabled={roles.length === 0 || disabled}
            onChange={(e) => {
              const next = e.target.checked ? [...roles, role] : roles.filter((r) => r !== role);
              onSave(next);
            }}
          />
          {role}
        </label>
      ))}
      <label className="flex items-center gap-1.5 cursor-pointer text-sm">
        <input
          type="checkbox"
          className="accent-accent"
          checked={roles.length === 0}
          disabled={disabled}
          onChange={(e) => onSave(e.target.checked ? [] : ["admin"])}
        />
        everyone
      </label>
    </div>
  );
}

type RetentionDraft = Record<string, { ageValue: string; ageUnit: "hours" | "days"; maxMessages: string }>;

export function AdminTopicsForm({ topics: initial }: { topics: TopicRow[] }) {
  const [topics, setTopics] = useState(initial);
  const [saving, setSaving] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retentionDraft, setRetentionDraft] = useState<RetentionDraft>(() =>
    Object.fromEntries(
      initial.map((t) => {
        const age = secondsToDisplay(t.autoDeleteAgeSeconds);
        return [t.id, { ageValue: age.value, ageUnit: age.unit, maxMessages: String(t.autoDeleteMaxMessages ?? 1000) }];
      }),
    ),
  );
  const router = useRouter();

  async function save(id: string, patch: Partial<TopicRow>, extra?: Record<string, unknown>) {
    setSaving(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/admin/topics/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...patch, ...extra }),
      });
      if (!res.ok) throw new Error("save failed");
      setTopics((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [id]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function toggleE2ee(id: string, enable: boolean) {
    if (enable) {
      const confirmed = window.confirm(
        "Enabling E2EE will permanently delete all existing messages in this topic. This cannot be undone.\n\nContinue?",
      );
      if (!confirmed) return;
      await save(id, { isE2ee: true }, { wipeMessages: true });
    } else {
      await save(id, { isE2ee: false });
    }
  }

  async function saveRetention(id: string) {
    const t = topics.find((t) => t.id === id)!;
    const draft = retentionDraft[id]!;
    const patch: Partial<TopicRow> = {};

    if (t.autoDeleteMode === "age") {
      const v = parseFloat(draft.ageValue);
      if (isNaN(v) || v <= 0) {
        setErrors((e) => ({ ...e, [id]: "Invalid age value" }));
        return;
      }
      patch.autoDeleteAgeSeconds = Math.round(v * (draft.ageUnit === "days" ? 86400 : 3600));
    } else if (t.autoDeleteMode === "count") {
      const v = parseInt(draft.maxMessages, 10);
      if (isNaN(v) || v <= 0) {
        setErrors((e) => ({ ...e, [id]: "Invalid count value" }));
        return;
      }
      patch.autoDeleteMaxMessages = v;
    }

    if (Object.keys(patch).length > 0) await save(id, patch);
  }

  async function purge(id: string) {
    setPurging(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const res = await fetch(`/api/admin/topics/${id}/messages`, { method: "DELETE" });
      if (!res.ok) throw new Error("purge failed");
    } catch {
      setErrors((e) => ({ ...e, [id]: "Purge failed" }));
    } finally {
      setPurging(null);
    }
  }

  return (
    <div className="space-y-3">
      {topics.map((t) => {
        const draft = retentionDraft[t.id]!;
        const dis = saving === t.id;
        return (
          <div key={t.id} className="rounded-xl border border-border bg-panel p-5 space-y-4">
            {/* Header + toggles */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{t.title}</div>
                <div className="text-xs text-muted">#{t.slug}</div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm">
                {(["isFeed", "isHomeTopic", "isSticky"] as const).map((key) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={t[key] as boolean}
                      onChange={(e) => save(t.id, { [key]: e.target.checked })}
                      className="accent-accent"
                      disabled={dis}
                    />
                    {{ isFeed: "Feed", isHomeTopic: "Home", isSticky: "Sticky" }[key]}
                  </label>
                ))}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={t.isE2ee}
                    onChange={(e) => toggleE2ee(t.id, e.target.checked)}
                    className="accent-accent"
                    disabled={dis}
                  />
                  E2EE
                </label>
              </div>
            </div>

            {/* Permissions */}
            <div className="space-y-3 border-t border-border pt-3">
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can read</div>
                <RolesCheckboxes roles={t.readRoles} onSave={(r) => save(t.id, { readRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">
                  {t.readRoles.length === 0 ? "Everyone can read." : `Only ${t.readRoles.join(", ")} can read.`}
                </p>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Who can post</div>
                <RolesCheckboxes roles={t.postRoles} onSave={(r) => save(t.id, { postRoles: r })} disabled={dis} />
                <p className="mt-1 text-xs text-muted">
                  {t.postRoles.length === 0 ? "Everyone can post." : `Only ${t.postRoles.join(", ")} can post.`}
                </p>
              </div>
            </div>

            {/* Retention */}
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Retention policy</div>
              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={t.autoDeleteMode}
                  onChange={(e) => save(t.id, { autoDeleteMode: e.target.value as "none" | "age" | "count" })}
                  disabled={dis}
                  className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                >
                  <option value="none">No limit</option>
                  <option value="age">By age</option>
                  <option value="count">By count</option>
                </select>

                {t.autoDeleteMode === "age" && (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      value={draft.ageValue}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({ ...d, [t.id]: { ...d[t.id]!, ageValue: e.target.value } }))
                      }
                      className="w-20 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    />
                    <select
                      value={draft.ageUnit}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({ ...d, [t.id]: { ...d[t.id]!, ageUnit: e.target.value as "hours" | "days" } }))
                      }
                      className="rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    >
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                    <button
                      onClick={() => saveRetention(t.id)}
                      disabled={dis}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}

                {t.autoDeleteMode === "count" && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted">keep last</span>
                    <input
                      type="number"
                      min="1"
                      value={draft.maxMessages}
                      onChange={(e) =>
                        setRetentionDraft((d) => ({ ...d, [t.id]: { ...d[t.id]!, maxMessages: e.target.value } }))
                      }
                      className="w-24 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm"
                    />
                    <span className="text-sm text-muted">messages</span>
                    <button
                      onClick={() => saveRetention(t.id)}
                      disabled={dis}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}

                {t.autoDeleteMode !== "none" && (
                  <button
                    onClick={() => purge(t.id)}
                    disabled={purging === t.id || dis}
                    className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
                  >
                    {purging === t.id ? "Purging…" : "Apply now"}
                  </button>
                )}
              </div>
            </div>

            {errors[t.id] && <p className="text-xs text-danger">{errors[t.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}
