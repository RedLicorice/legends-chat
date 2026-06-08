"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ExternalLinkProvider } from "@/contexts/ExternalLinkContext";

interface BrandingPayload {
  externalLinks?: {
    interstitialEnabled?: boolean;
    whitelist?: string[];
    publicOrigin?: string | null;
  };
}

const DEFAULT_CONFIG = {
  interstitialEnabled: true,
  whitelist: [] as string[],
  publicOrigin: null as string | null,
};

/**
 * Client wrapper that fetches the external-link interstitial config from
 * /api/branding once on mount, then renders ExternalLinkProvider with the
 * resolved config. While the fetch is in flight we render with safe defaults
 * (interstitial on, empty whitelist) so links open through the dialog rather
 * than navigating immediately.
 *
 * This exists so the root layout can stay fully static — no cookies(), no DB.
 */
export function ExternalLinkBootstrap({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG);

  useEffect(() => {
    let mounted = true;
    fetch("/api/branding", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BrandingPayload | null) => {
        if (!mounted || !j?.externalLinks) return;
        const e = j.externalLinks;
        setConfig({
          interstitialEnabled: e.interstitialEnabled ?? DEFAULT_CONFIG.interstitialEnabled,
          whitelist: e.whitelist ?? DEFAULT_CONFIG.whitelist,
          publicOrigin: e.publicOrigin ?? DEFAULT_CONFIG.publicOrigin,
        });
      })
      .catch(() => { /* leave defaults */ });
    return () => { mounted = false; };
  }, []);

  return <ExternalLinkProvider config={config}>{children}</ExternalLinkProvider>;
}
