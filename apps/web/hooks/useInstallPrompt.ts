"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  | { type: "unavailable" }
  | { type: "native"; install: () => Promise<void> }
  | { type: "ios" }; // show manual instructions

function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isInStandaloneMode() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in window.navigator && (window.navigator as { standalone?: boolean }).standalone === true);
}

export function useInstallPrompt(): InstallState {
  const [state, setState] = useState<InstallState>({ type: "unavailable" });

  useEffect(() => {
    if (isInStandaloneMode()) return; // already installed

    if (isIos()) {
      setState({ type: "ios" });
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      const prompt = e as BeforeInstallPromptEvent;
      setState({
        type: "native",
        install: async () => {
          await prompt.prompt();
          const { outcome } = await prompt.userChoice;
          if (outcome === "accepted") setState({ type: "unavailable" });
        },
      });
    };

    window.addEventListener("beforeinstallprompt", handler);
    window.addEventListener("appinstalled", () => setState({ type: "unavailable" }));
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  return state;
}
