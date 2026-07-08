"use client";

import { useState } from "react";
import { Download, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

// Self-contained install affordance: the button plus the iOS/Android manual
// instruction modals. Renders nothing when the app is already installed
// (standalone) or install isn't offered. Safe to drop anywhere — used on the
// login screen and available to the in-app shell.
export function InstallButton({ className }: { className?: string }) {
  const installState = useInstallPrompt();
  const [showIos, setShowIos] = useState(false);
  const [showAndroid, setShowAndroid] = useState(false);

  if (installState.type === "unavailable") return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (installState.type === "native") void installState.install();
          else if (installState.type === "ios") setShowIos(true);
          else if (installState.type === "android") setShowAndroid(true);
        }}
        className={
          className ??
          "flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-panel py-2.5 text-sm font-medium text-text hover:bg-panel2 transition"
        }
      >
        <Download className="h-4 w-4 text-muted" /> Install app
      </button>

      {showIos && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 md:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Install on iPhone / iPad</h2>
              <button type="button" onClick={() => setShowIos(false)} className="text-muted hover:text-text">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ol className="space-y-3 text-sm text-muted">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">1</span>
                Tap the <strong className="text-text">Share</strong> button at the bottom of Safari (the square with an arrow pointing up).
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">2</span>
                Scroll down and tap <strong className="text-text">Add to Home Screen</strong>.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">3</span>
                Tap <strong className="text-text">Add</strong> in the top-right corner.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowIos(false)}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {showAndroid && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 md:items-center">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Install on Android</h2>
              <button type="button" onClick={() => setShowAndroid(false)} className="text-muted hover:text-text">
                <X className="h-5 w-5" />
              </button>
            </div>
            <ol className="space-y-3 text-sm text-muted">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">1</span>
                Tap the <strong className="text-text">menu</strong> button (⋮) in the top-right corner of Chrome.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">2</span>
                Tap <strong className="text-text">Add to Home screen</strong>.
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">3</span>
                Tap <strong className="text-text">Add</strong> to confirm.
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowAndroid(false)}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
