"use client";

import { useState } from "react";
import { Plus, Trash2, Copy, Star, StarOff, ChevronDown, ChevronUp } from "lucide-react";
import { useRouter } from "next/navigation";

const COLOR_KEYS = [
  { key: "bg",      label: "Background" },
  { key: "panel",   label: "Panel" },
  { key: "panel2",  label: "Panel 2" },
  { key: "border",  label: "Border" },
  { key: "text",    label: "Text" },
  { key: "muted",   label: "Muted text" },
  { key: "accent",  label: "Accent" },
  { key: "accent2", label: "Accent 2" },
  { key: "danger",  label: "Danger" },
] as const;

type ColorKey = (typeof COLOR_KEYS)[number]["key"];

const DEFAULT_COLORS: Record<ColorKey, string> = {
  bg: "11 13 18",
  panel: "20 24 33",
  panel2: "26 31 43",
  border: "38 45 59",
  text: "230 233 242",
  muted: "138 147 166",
  accent: "124 92 255",
  accent2: "92 200 255",
  danger: "255 92 124",
};

interface ThemeRow {
  id: string;
  name: string;
  isBuiltin: boolean;
  colors: Record<string, string>;
  isGlass: boolean;
  bgGradient: string;
}

interface Props {
  themes: ThemeRow[];
  defaultTheme: string;
}

// ── Conversion helpers ──────────────────────────────────────────────────────

function channelsToHex(ch: string): string {
  const parts = (ch ?? "").trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "#000000";
  return "#" + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}

function hexToChannels(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "0 0 0";
  return [
    parseInt(m[1]!.slice(0, 2), 16),
    parseInt(m[1]!.slice(2, 4), 16),
    parseInt(m[1]!.slice(4, 6), 16),
  ].join(" ");
}

// ── Color swatch preview ────────────────────────────────────────────────────

function ThemePreview({ colors, isGlass }: { colors: Record<string, string>; isGlass: boolean }) {
  const bg = channelsToHex(colors.bg ?? DEFAULT_COLORS.bg);
  const panel = channelsToHex(colors.panel ?? DEFAULT_COLORS.panel);
  const accent = channelsToHex(colors.accent ?? DEFAULT_COLORS.accent);
  const text = channelsToHex(colors.text ?? DEFAULT_COLORS.text);
  const muted = channelsToHex(colors.muted ?? DEFAULT_COLORS.muted);

  return (
    <div className="h-16 w-28 overflow-hidden rounded-lg shrink-0" style={{ background: bg }}>
      <div className="flex h-full gap-1 p-1.5">
        <div className="flex w-8 flex-col gap-1 rounded p-1" style={{ background: isGlass ? `${panel}99` : panel }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-1.5 rounded-sm" style={{ background: muted, opacity: i === 1 ? 0.9 : 0.45 }} />
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded p-1" style={{ background: isGlass ? `${panel}99` : panel }}>
          <div className="h-1.5 w-3/4 rounded-sm" style={{ background: text, opacity: 0.8 }} />
          <div className="mt-auto flex justify-end">
            <div className="h-4 w-10 rounded" style={{ background: accent }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main form ───────────────────────────────────────────────────────────────

export function AdminThemesForm({ themes: initial, defaultTheme: initialDefault }: Props) {
  const [themes, setThemes] = useState(initial);
  const [defaultTheme, setDefaultTheme] = useState(initialDefault);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editColors, setEditColors] = useState<Record<string, Record<ColorKey, string>>>(() =>
    Object.fromEntries(initial.map((t) => [t.id, Object.fromEntries(COLOR_KEYS.map(({ key }) => [key, t.colors[key] ?? DEFAULT_COLORS[key]])) as Record<ColorKey, string>])),
  );
  const [editNames, setEditNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((t) => [t.id, t.name])),
  );
  const [editGlass, setEditGlass] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initial.map((t) => [t.id, t.isGlass])),
  );
  const [editGradient, setEditGradient] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.map((t) => [t.id, t.bgGradient])),
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createId, setCreateId] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const router = useRouter();

  function setColor(themeId: string, key: ColorKey, hex: string) {
    setEditColors((prev) => ({
      ...prev,
      [themeId]: { ...prev[themeId]!, [key]: hexToChannels(hex) },
    }));
  }

  async function saveTheme(id: string) {
    setSaving(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    setSaved((s) => ({ ...s, [id]: false }));
    try {
      const res = await fetch(`/api/admin/themes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: editNames[id],
          colors: editColors[id],
          isGlass: editGlass[id],
          bgGradient: editGradient[id] || null,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setThemes((prev) => prev.map((t) => t.id === id ? { ...t, name: editNames[id] ?? t.name, colors: editColors[id] ?? t.colors, isGlass: editGlass[id] ?? t.isGlass, bgGradient: editGradient[id] ?? t.bgGradient } : t));
      setSaved((s) => ({ ...s, [id]: true }));
      router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [id]: "Save failed" }));
    } finally {
      setSaving(null);
    }
  }

  async function setDefault(id: string) {
    await fetch(`/api/admin/themes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setDefault: true }),
    });
    setDefaultTheme(id);
    router.refresh();
  }

  async function deleteTheme(id: string, name: string) {
    if (!window.confirm(`Delete theme "${name}"? Users who selected it will fall back to the default.`)) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/admin/themes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "delete failed");
      }
      setThemes((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: (e as Error).message }));
    } finally {
      setDeleting(null);
    }
  }

  async function createTheme() {
    const id = (createId || createName).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!id || !createName.trim()) { setCreateError("Name required"); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/themes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: createName.trim(), cloneFrom: cloneFrom || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "Create failed"); return; }
      const newTheme: ThemeRow = { id: data.id, name: data.name, isBuiltin: false, colors: data.colors, isGlass: data.isGlass, bgGradient: data.bgGradient ?? "" };
      setThemes((prev) => [...prev, newTheme]);
      setEditColors((p) => ({ ...p, [newTheme.id]: Object.fromEntries(COLOR_KEYS.map(({ key }) => [key, newTheme.colors[key] ?? DEFAULT_COLORS[key]])) as Record<ColorKey, string> }));
      setEditNames((p) => ({ ...p, [newTheme.id]: newTheme.name }));
      setEditGlass((p) => ({ ...p, [newTheme.id]: newTheme.isGlass }));
      setEditGradient((p) => ({ ...p, [newTheme.id]: newTheme.bgGradient }));
      setCreateName("");
      setCreateId("");
      setCloneFrom("");
      setShowCreate(false);
      setExpanded(newTheme.id);
    } catch {
      setCreateError("Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Create form */}
      {showCreate ? (
        <div className="rounded-xl border border-accent bg-panel p-5 space-y-3">
          <h2 className="text-sm font-semibold">New theme</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Name</label>
              <input
                value={createName}
                onChange={(e) => {
                  setCreateName(e.target.value);
                  if (!createId) setCreateId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
                }}
                placeholder="My Theme"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">ID (slug)</label>
              <input
                value={createId}
                onChange={(e) => setCreateId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                placeholder="my-theme"
                className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Clone colors from</label>
            <select
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
              className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent sm:w-64"
            >
              <option value="">— dark (default) —</option>
              {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {createError && <p className="text-xs text-danger">{createError}</p>}
          <div className="flex gap-2">
            <button onClick={createTheme} disabled={creating || !createName} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              {creating ? "Creating…" : "Create theme"}
            </button>
            <button onClick={() => { setShowCreate(false); setCreateName(""); setCreateId(""); setCloneFrom(""); setCreateError(null); }} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-panel2">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-panel2">
          <Plus className="h-4 w-4" /> New theme
        </button>
      )}

      {/* Theme list */}
      {themes.map((theme) => {
        const isExpanded = expanded === theme.id;
        const colors = editColors[theme.id] ?? ({} as Record<ColorKey, string>);
        const isDefault = defaultTheme === theme.id;
        const dis = saving === theme.id || deleting === theme.id;

        return (
          <div key={theme.id} className="rounded-xl border border-border bg-panel overflow-hidden">
            {/* Header row */}
            <div className="flex items-center gap-3 p-4">
              <ThemePreview colors={colors} isGlass={editGlass[theme.id] ?? false} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{editNames[theme.id] ?? theme.name}</span>
                  <code className="rounded bg-panel2 px-1.5 py-0.5 text-xs font-mono text-muted">{theme.id}</code>
                  {theme.isBuiltin && (
                    <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">built-in</span>
                  )}
                  {isDefault && (
                    <span className="rounded-full bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-400">default</span>
                  )}
                  {editGlass[theme.id] && (
                    <span className="rounded-full bg-panel2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">glass</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(["bg", "panel", "accent", "text", "muted", "danger"] as ColorKey[]).map((k) => (
                    <span key={k} className="inline-block h-3 w-3 rounded-full border border-white/10" style={{ background: channelsToHex(colors[k] ?? DEFAULT_COLORS[k]) }} title={k} />
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {!isDefault && (
                  <button onClick={() => setDefault(theme.id)} title="Set as default" className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2">
                    <StarOff className="h-4 w-4" />
                  </button>
                )}
                {isDefault && (
                  <span title="Default theme" className="rounded-lg p-1.5 text-yellow-400">
                    <Star className="h-4 w-4" />
                  </span>
                )}
                <button
                  onClick={() => {
                    setCreateName(theme.name + " copy");
                    setCreateId(theme.id + "-copy");
                    setCloneFrom(theme.id);
                    setShowCreate(true);
                  }}
                  title="Clone theme"
                  className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2"
                >
                  <Copy className="h-4 w-4" />
                </button>
                {!theme.isBuiltin && (
                  <button
                    onClick={() => deleteTheme(theme.id, theme.name)}
                    disabled={dis}
                    title="Delete theme"
                    className="rounded-lg p-1.5 text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => setExpanded(isExpanded ? null : theme.id)}
                  className="rounded-lg p-1.5 text-muted hover:text-text hover:bg-panel2"
                >
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Expanded editor */}
            {isExpanded && (
              <div className="border-t border-border p-4 space-y-4">
                {/* Name */}
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Display name</label>
                  <input
                    value={editNames[theme.id] ?? theme.name}
                    onChange={(e) => setEditNames((p) => ({ ...p, [theme.id]: e.target.value }))}
                    disabled={dis}
                    className="rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                </div>

                {/* Colors grid */}
                <div>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Colors</div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {COLOR_KEYS.map(({ key, label }) => {
                      const ch = colors[key] ?? DEFAULT_COLORS[key];
                      const hex = channelsToHex(ch);
                      return (
                        <div key={key}>
                          <label className="mb-1 block text-xs text-muted">{label}</label>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={hex}
                              onChange={(e) => setColor(theme.id, key, e.target.value)}
                              disabled={dis}
                              className="h-8 w-10 cursor-pointer rounded border border-border bg-panel2 p-0.5"
                            />
                            <input
                              type="text"
                              value={hex}
                              onChange={(e) => setColor(theme.id, key, e.target.value)}
                              disabled={dis}
                              maxLength={7}
                              className="w-20 rounded-lg border border-border bg-panel2 px-2 py-1.5 text-xs font-mono outline-none focus:border-accent"
                            />
                          </div>
                          <div className="mt-0.5 text-[10px] font-mono text-muted/60">{ch}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Glass toggle */}
                <div>
                  <label className="flex cursor-pointer items-center gap-3">
                    <div
                      role="switch"
                      aria-checked={editGlass[theme.id] ?? false}
                      onClick={() => !dis && setEditGlass((p) => ({ ...p, [theme.id]: !p[theme.id] }))}
                      className={`relative h-6 w-11 cursor-pointer rounded-full transition-colors ${(editGlass[theme.id] ?? false) ? "bg-accent" : "bg-border"}`}
                    >
                      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${(editGlass[theme.id] ?? false) ? "translate-x-6" : "translate-x-1"}`} />
                    </div>
                    <div>
                      <div className="text-sm font-medium">Glass mode</div>
                      <div className="text-xs text-muted">Adds backdrop blur and semi-transparent panels. Works best with a gradient background.</div>
                    </div>
                  </label>
                </div>

                {/* BG gradient (glass only) */}
                {(editGlass[theme.id] ?? false) && (
                  <div>
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Background gradient</label>
                    <input
                      value={editGradient[theme.id] ?? ""}
                      onChange={(e) => setEditGradient((p) => ({ ...p, [theme.id]: e.target.value }))}
                      disabled={dis}
                      placeholder="radial-gradient(ellipse 90% 90% at 15% 10%, #1c1448 0%, #0b0e22 55%, #070c14 100%)"
                      className="w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm font-mono outline-none focus:border-accent"
                    />
                    <p className="mt-1 text-xs text-muted">Any valid CSS gradient. Leave blank to use the default indigo gradient.</p>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={() => saveTheme(theme.id)}
                    disabled={dis}
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {saving === theme.id ? "Saving…" : "Save theme"}
                  </button>
                  {!isDefault && (
                    <button
                      onClick={() => setDefault(theme.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2"
                    >
                      <Star className="h-3.5 w-3.5" /> Set as default
                    </button>
                  )}
                  {errors[theme.id] && <p className="text-xs text-danger">{errors[theme.id]}</p>}
                  {saved[theme.id] && <p className="text-xs text-green-400">Saved.</p>}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
