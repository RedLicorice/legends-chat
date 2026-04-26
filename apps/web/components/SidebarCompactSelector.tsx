"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

interface Props {
  defaultValue: string;
}

const OPTIONS = [
  {
    value: "minimal",
    label: "Minimal",
    description: "Button in header — no sidebar space used",
  },
  {
    value: "strip",
    label: "Strip",
    description: "Icon bar shown at the side",
  },
] as const;

export function SidebarCompactSelector({ defaultValue }: Props) {
  const [value, setValue] = useState(defaultValue);

  function select(v: string) {
    setValue(v);
    document.cookie = `lc_sidebar_compact=${v};path=/;max-age=${365 * 24 * 3600}`;
    document.documentElement.dataset.sidebarCompact = v;
  }

  return (
    <div className="space-y-2">
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
        Collapsed sidebar style
      </label>
      <div className="flex gap-3">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => select(opt.value)}
            className={cn(
              "flex-1 rounded-xl border px-4 py-3 text-left transition",
              value === opt.value
                ? "border-accent bg-accent/10 text-text"
                : "border-border bg-panel2 text-muted hover:border-accent/50 hover:text-text",
            )}
          >
            <div className="text-sm font-medium">{opt.label}</div>
            <div className="mt-0.5 text-xs">{opt.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
