"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function BrowserOpenPage() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const verifyUrl = token ? `/auth/callback?token=${encodeURIComponent(token)}` : null;
  const [platform, setPlatform] = useState<"android" | "ios" | "other">("other");

  useEffect(() => {
    if (!verifyUrl) return;
    const ua = navigator.userAgent;
    const isAndroid = /android/i.test(ua);
    const isIos = /iphone|ipad|ipod/i.test(ua);

    if (isAndroid) {
      setPlatform("android");
      // intent:// forces Chrome to open the URL even from inside a WebView.
      const host = window.location.host;
      const path = `/auth/callback?token=${encodeURIComponent(token)}`;
      const fallback = encodeURIComponent(`https://${host}${path}`);
      const intent = `intent://${host}${path}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
      window.location.href = intent;
    } else if (isIos) {
      setPlatform("ios");
    } else {
      // Desktop or unknown — just redirect inline.
      window.location.replace(verifyUrl);
    }
  }, [verifyUrl, token]);

  if (!token) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-text">
        <p className="text-sm text-muted">Invalid link.</p>
      </div>
    );
  }

  if (platform === "android") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-bg px-8 text-center text-text">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Opening Chrome…</p>
          <p className="text-sm text-muted">If Chrome didn&apos;t open, tap the button below.</p>
        </div>
        <a
          href={verifyUrl!}
          className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white"
        >
          Log in to Legends Chat
        </a>
      </div>
    );
  }

  if (platform === "ios") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-bg px-8 text-center text-text">
        <div className="space-y-2">
          <p className="text-lg font-semibold">Open in Safari</p>
          <p className="text-sm text-muted">
            Tap <strong>···</strong> (top right) then <strong>Open in Safari</strong>, or tap the
            button and long-press → <em>Open in Safari</em>.
          </p>
        </div>
        <a
          href={verifyUrl!}
          className="rounded-xl bg-accent px-6 py-3 text-sm font-semibold text-white"
        >
          Log in to Legends Chat
        </a>
        <p className="text-xs text-muted">
          Link expires in 5 minutes.
        </p>
      </div>
    );
  }

  // Fallback while detecting / redirecting.
  return (
    <div className="flex h-dvh items-center justify-center bg-bg text-text">
      <p className="text-sm text-muted">Redirecting…</p>
    </div>
  );
}
