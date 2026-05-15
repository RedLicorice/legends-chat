"use client";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SettingsTab<K extends string> = {
  key: K;
  label: string;
  icon?: ComponentType<{ className?: string }>;
};

export function SettingsTabs<K extends string>({
  tabs,
  panels,
  initial,
}: {
  tabs: readonly SettingsTab<K>[];
  panels: Record<K, ReactNode>;
  initial?: K;
}) {
  const firstKey = tabs[0]?.key;
  if (firstKey === undefined) throw new Error("SettingsTabs requires at least one tab");
  const [active, setActive] = useState<K>(initial ?? firstKey);

  useEffect(() => {
    const keys = tabs.map((t) => t.key);
    const fromHash = () => {
      const h = window.location.hash.replace("#", "");
      if (keys.includes(h as K)) setActive(h as K);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [tabs]);

  function select(key: K) {
    setActive(key);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${key}`);
    }
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="sticky top-[var(--sat)] z-10 -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-border bg-panel p-1 shadow-sm backdrop-blur"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`settings-panel-${t.key}`}
              onClick={() => select(t.key)}
              className={cn(
                "flex min-h-[44px] flex-1 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-bg text-text shadow-sm"
                  : "text-muted hover:text-text",
              )}
            >
              {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div
        id={`settings-panel-${active}`}
        role="tabpanel"
        aria-labelledby={String(active)}
        className="space-y-4"
      >
        {panels[active]}
      </div>
    </>
  );
}
