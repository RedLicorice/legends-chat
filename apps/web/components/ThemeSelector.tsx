"use client";

import { useState, useEffect } from "react";
import { Check } from "lucide-react";

const THEMES = [
  {
    id: "dark",
    name: "Dark",
    description: "Default dark theme",
    preview: {
      bg: "#0b0d12",
      panel: "#141821",
      accent: "#7c5cff",
      text: "#e6e9f2",
      muted: "#8a93a6",
    },
  },
  {
    id: "matte-glass",
    name: "Matte Glass",
    description: "Frosted glass panels on a deep indigo background",
    preview: {
      bg: "#0f0c23",
      panel: "rgba(27, 22, 54, 0.60)",
      accent: "#8b70ff",
      text: "#eeeffc",
      muted: "#9a9cc0",
    },
  },
] as const;

type ThemeId = (typeof THEMES)[number]["id"];

const COOKIE_NAME = "lc_theme";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function ThemeSelector({ defaultTheme }: { defaultTheme?: string }) {
  const [current, setCurrent] = useState<string>(() => {
    if (typeof document === "undefined") return defaultTheme ?? "dark";
    return document.documentElement.dataset.theme ?? defaultTheme ?? "dark";
  });

  useEffect(() => {
    setCurrent(document.documentElement.dataset.theme ?? defaultTheme ?? "dark");
  }, [defaultTheme]);

  function selectTheme(id: ThemeId) {
    setCurrent(id);
    document.documentElement.dataset.theme = id;
    document.cookie = `${COOKIE_NAME}=${id}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {THEMES.map((theme) => {
        const selected = current === theme.id;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => selectTheme(theme.id as ThemeId)}
            className={`relative rounded-xl border-2 p-4 text-left transition-all ${
              selected ? "border-accent shadow-lg shadow-accent/20" : "border-border hover:border-muted"
            }`}
          >
            {selected && (
              <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
                <Check className="h-3 w-3" />
              </span>
            )}

            {/* Color swatch preview */}
            <div
              className="mb-3 h-20 w-full overflow-hidden rounded-lg"
              style={{ background: theme.preview.bg }}
            >
              <div className="flex h-full gap-1.5 p-2">
                {/* Fake sidebar */}
                <div className="flex w-10 flex-col gap-1 rounded-md p-1.5" style={{ background: theme.preview.panel }}>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-2 rounded-sm" style={{ background: theme.preview.muted, opacity: i === 1 ? 1 : 0.5 }} />
                  ))}
                </div>
                {/* Fake chat area */}
                <div className="flex flex-1 flex-col gap-1 rounded-md p-1.5" style={{ background: theme.preview.panel }}>
                  <div className="flex gap-1 items-center">
                    <div className="h-3 w-3 rounded-full shrink-0" style={{ background: theme.preview.accent }} />
                    <div className="h-1.5 flex-1 rounded-full" style={{ background: theme.preview.muted }} />
                  </div>
                  <div className="h-1.5 w-3/4 rounded-full" style={{ background: theme.preview.text, opacity: 0.7 }} />
                  <div className="mt-auto flex gap-1 justify-end">
                    <div className="h-5 rounded-lg px-2 flex items-center" style={{ background: theme.preview.accent, opacity: 0.9 }}>
                      <div className="h-1.5 w-8 rounded-full bg-white/80" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="font-medium text-sm">{theme.name}</div>
            <div className="mt-0.5 text-xs text-muted">{theme.description}</div>
          </button>
        );
      })}
    </div>
  );
}
