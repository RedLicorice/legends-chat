"use client";

import { useEffect, useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { shouldBlockInAppBrowser } from "@/lib/in-app-browser";

/**
 * Wraps the app. If we're in an embedded in-app browser (or service workers are
 * unavailable), render an "open in your real browser" screen instead of the app
 * — the providers/service-worker/passkey machinery below would otherwise fail.
 *
 * Detection is client-only, so children render during SSR and the very first
 * client frame; the gate swaps in on mount. A "continue anyway" escape hatch
 * covers the rare iOS UA false-positive.
 */
export function InAppBrowserGate({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState(false);
  const [bypass, setBypass] = useState(false);

  useEffect(() => {
    setBlocked(shouldBlockInAppBrowser());
  }, []);

  if (blocked && !bypass) {
    return <InAppScreen onContinue={() => setBypass(true)} />;
  }
  return <>{children}</>;
}

function InAppScreen({ onContinue }: { onContinue: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined" ? window.location.href : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Some in-app browsers block the clipboard API — fall back to a hidden
      // textarea + execCommand so copy still works.
      try {
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      } catch {
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg px-6 py-10 text-center text-text">
      <img src="/api/favicon" alt="" width={72} height={72} className="rounded-2xl" />
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">Open in your browser</h1>
        <p className="mx-auto max-w-sm text-sm text-muted">
          You&apos;re viewing this inside another app&apos;s built-in browser, which
          can&apos;t run secure sign-in or install the app. Open the link in Safari,
          Chrome, or your default browser to continue.
        </p>
      </div>

      <div className="w-full max-w-sm space-y-2 text-left">
        <div className="truncate rounded-lg border border-border bg-panel2 px-3 py-2 text-xs text-muted" title={url}>
          {url}
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>

      <ol className="mx-auto max-w-sm space-y-2 text-left text-xs text-muted">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-panel2 text-[10px] font-semibold text-text">1</span>
          Tap the <ExternalLink className="mx-0.5 inline h-3 w-3" /> / menu (⋯) in this app&apos;s browser bar.
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-panel2 text-[10px] font-semibold text-text">2</span>
          Choose <strong className="text-text">Open in Safari</strong> / <strong className="text-text">Open in browser</strong> — or paste the copied link there.
        </li>
      </ol>

      <button type="button" onClick={onContinue} className="text-xs text-muted underline underline-offset-2 hover:text-text">
        Continue anyway
      </button>
    </div>
  );
}
