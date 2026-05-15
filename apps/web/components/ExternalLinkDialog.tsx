"use client";
import { useEffect, useMemo } from "react";
import { ExternalLink, X, AlertTriangle } from "lucide-react";
import { useExternalLink } from "@/contexts/ExternalLinkContext";

export function ExternalLinkDialog() {
  const { pending, confirm, cancel } = useExternalLink();

  // ESC to cancel
  useEffect(() => {
    if (!pending) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
      if (e.key === "Enter") confirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cancel, confirm]);

  const parsed = useMemo(() => {
    if (!pending) return null;
    try {
      const u = new URL(pending);
      return { host: u.host, rest: u.pathname + u.search + u.hash, origin: u.origin };
    } catch {
      return null;
    }
  }, [pending]);

  if (!pending || !parsed) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="external-link-title"
      className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
      onClick={cancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-2xl border border-border bg-panel p-5 shadow-xl sm:rounded-2xl"
        style={{ paddingBottom: "max(1.25rem, var(--sab))" }}
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h2 id="external-link-title" className="text-base font-semibold">Leaving the app</h2>
            <p className="mt-0.5 text-xs text-muted">
              You are about to open an external website. The destination is unaffiliated with this community.
            </p>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="-mr-1 -mt-1 rounded p-1 text-muted hover:text-text"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-panel2 px-3 py-2.5">
          <p className="break-all font-mono text-xs leading-relaxed">
            <span className="text-muted">{parsed.origin.replace(parsed.host, "")}</span>
            <span className="font-semibold text-text">{parsed.host}</span>
            <span className="text-muted">{parsed.rest}</span>
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={cancel}
            className="flex-1 rounded-lg border border-border bg-panel2 px-4 py-2.5 text-sm font-medium text-text hover:bg-panel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            autoFocus
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" />
            Open link
          </button>
        </div>
      </div>
    </div>
  );
}
