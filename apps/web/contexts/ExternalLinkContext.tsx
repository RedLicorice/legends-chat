"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface ExternalLinkConfig {
  interstitialEnabled: boolean;
  whitelist: string[];          // pre-normalized hostnames (lowercase, no www.)
  publicOrigin: string | null;  // skip interstitial for same-origin URLs
}

interface ExternalLinkContextValue {
  requestOpen: (url: string) => void;
  pending: string | null;
  confirm: () => void;
  cancel: () => void;
  config: ExternalLinkConfig;
}

const Ctx = createContext<ExternalLinkContextValue | null>(null);

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/^www\./, "");
}

function hostMatches(host: string, entry: string): boolean {
  if (!entry) return false;
  return host === entry || host.endsWith("." + entry);
}

function isSafeProtocol(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function openSafe(url: string): void {
  // noopener strips window.opener; noreferrer strips Referer for the new
  // window even if the global header somehow allowed one.
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ExternalLinkProvider({
  config,
  children,
}: {
  config: ExternalLinkConfig;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const requestOpen = useCallback((url: string) => {
    if (!isSafeProtocol(url)) {
      // mailto:, tel:, javascript: etc — never intercept; never open via window.open
      // (avoid javascript: smuggling). Let the browser handle natively only if the
      // anchor isn't preventDefault'd by the caller. Here we just bail.
      return;
    }
    let host: string;
    let origin: string;
    try {
      const u = new URL(url);
      host = normalizeHost(u.hostname);
      origin = u.origin;
    } catch {
      return;
    }

    // Same-origin → open directly (no warning for our own URLs)
    if (config.publicOrigin && origin === config.publicOrigin) {
      openSafe(url);
      return;
    }

    // Interstitial disabled → open directly (admin opt-out)
    if (!config.interstitialEnabled) {
      openSafe(url);
      return;
    }

    // Whitelist hit → open directly
    if (config.whitelist.some((e) => hostMatches(host, e))) {
      openSafe(url);
      return;
    }

    // Otherwise prompt
    setPending(url);
  }, [config]);

  const confirm = useCallback(() => {
    if (pending) openSafe(pending);
    setPending(null);
  }, [pending]);

  const cancel = useCallback(() => setPending(null), []);

  const value = useMemo<ExternalLinkContextValue>(
    () => ({ requestOpen, pending, confirm, cancel, config }),
    [requestOpen, pending, confirm, cancel, config],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useExternalLink(): ExternalLinkContextValue {
  const v = useContext(Ctx);
  if (!v) {
    // Provider not mounted — return a no-op so callers don't crash in isolated
    // test/preview environments. Real app always wraps with provider.
    return {
      requestOpen: (url: string) => { if (isSafeProtocol(url)) openSafe(url); },
      pending: null,
      confirm: () => {},
      cancel: () => {},
      config: { interstitialEnabled: false, whitelist: [], publicOrigin: null },
    };
  }
  return v;
}

export function parseWhitelist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => normalizeHost(s))
    .filter(Boolean);
}
