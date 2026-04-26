"use client";

import { useState, useEffect } from "react";
import { Check } from "lucide-react";

const COOKIE_NAME = "lc_theme";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

interface ThemeInfo {
  id: string;
  name: string;
  colors: Record<string, string>;
  isGlass: boolean;
}

function channelsToHex(ch: string): string {
  const parts = (ch ?? "").trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "#000000";
  return "#" + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}

function ThemeCard({ theme, selected, onSelect }: { theme: ThemeInfo; selected: boolean; onSelect: () => void }) {
  const c = theme.colors;
  const bg = channelsToHex(c.bg ?? "11 13 18");
  const panel = channelsToHex(c.panel ?? "20 24 33");
  const accent = channelsToHex(c.accent ?? "124 92 255");
  const text = channelsToHex(c.text ?? "230 233 242");
  const muted = channelsToHex(c.muted ?? "138 147 166");
  const panelStyle = theme.isGlass ? `${panel}99` : panel;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative rounded-xl border-2 p-4 text-left transition-all ${selected ? "border-accent shadow-lg shadow-accent/20" : "border-border hover:border-muted"}`}
    >
      {selected && (
        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
          <Check className="h-3 w-3" />
        </span>
      )}
      {/* Preview */}
      <div className="mb-3 h-20 w-full overflow-hidden rounded-lg" style={{ background: bg }}>
        <div className="flex h-full gap-1.5 p-2">
          <div className="flex w-10 flex-col gap-1 rounded-md p-1.5" style={{ background: panelStyle }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-2 rounded-sm" style={{ background: muted, opacity: i === 1 ? 1 : 0.45 }} />
            ))}
          </div>
          <div className="flex flex-1 flex-col gap-1 rounded-md p-1.5" style={{ background: panelStyle }}>
            <div className="flex gap-1 items-center">
              <div className="h-3 w-3 rounded-full shrink-0" style={{ background: accent }} />
              <div className="h-1.5 flex-1 rounded-full" style={{ background: muted }} />
            </div>
            <div className="h-1.5 w-3/4 rounded-full" style={{ background: text, opacity: 0.7 }} />
            <div className="mt-auto flex gap-1 justify-end">
              <div className="h-5 rounded-lg px-2 flex items-center" style={{ background: accent }}>
                <div className="h-1.5 w-8 rounded-full bg-white/80" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="font-medium text-sm">{theme.name}</div>
    </button>
  );
}

export function ThemeSelector({ defaultTheme }: { defaultTheme?: string }) {
  const [current, setCurrent] = useState<string>(defaultTheme ?? "dark");
  const [availableThemes, setAvailableThemes] = useState<ThemeInfo[]>([]);

  useEffect(() => {
    const active = document.documentElement.dataset.theme ?? defaultTheme ?? "dark";
    setCurrent(active);

    fetch("/api/themes")
      .then((r) => r.ok ? r.json() : [])
      .then((data: ThemeInfo[]) => { if (Array.isArray(data)) setAvailableThemes(data); })
      .catch(() => {});
  }, [defaultTheme]);

  function selectTheme(id: string) {
    setCurrent(id);
    document.documentElement.dataset.theme = id;
    const isGlass = availableThemes.find((t) => t.id === id)?.isGlass ?? false;
    document.documentElement.dataset.glass = isGlass ? "1" : "0";
    document.cookie = `${COOKIE_NAME}=${id}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  if (availableThemes.length === 0) {
    return <p className="text-sm text-muted">Loading themes…</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {availableThemes.map((theme) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          selected={current === theme.id}
          onSelect={() => selectTheme(theme.id)}
        />
      ))}
    </div>
  );
}
