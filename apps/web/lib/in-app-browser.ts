// In-app (embedded webview) browser detection.
//
// Social/messenger apps (Telegram, Instagram, Facebook, …) open links in an
// embedded WebView that lacks the capabilities this PWA needs — service worker,
// WebAuthn/passkeys, install-to-home-screen, persistent IndexedDB for the crypto
// store. Detecting it lets us show a "open in your real browser" screen instead
// of a broken app. Especially relevant here because the chat is Telegram-linked,
// so shared links routinely open inside Telegram's in-app browser.
//
// Technique mirrors common practice (no clean API exists): UA tokens + platform
// heuristics + Telegram's injected window globals. Approach adapted from
// arkade-os/wallet#423, with a critical addition: an installed standalone PWA is
// explicitly NOT treated as in-app (its iOS WKWebView UA also lacks "Safari",
// which would otherwise false-positive the iOS heuristic and bounce our own app).

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

/** True when running inside a known embedded in-app browser / webview. */
export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  // The installed app is the goal state, never "in-app". Must come first.
  if (isStandalone()) return false;

  const ua = navigator.userAgent || (navigator as Navigator & { vendor?: string }).vendor || "";

  // 1. Known in-app browser UA tokens.
  if (
    /FBAN|FBAV|FB_IAB|Instagram|Twitter|\bLine\b|Snapchat|LinkedIn|Reddit|Pinterest|TikTok|Telegram|MicroMessenger|Weibo|KAKAOTALK|Viber/i.test(
      ua,
    )
  ) {
    return true;
  }

  // 2. Telegram on iOS ships no UA token — it injects these globals instead.
  if (
    typeof window !== "undefined" &&
    ("TelegramWebviewProxy" in window || "TelegramWebviewProxyProto" in window)
  ) {
    return true;
  }

  // 3. Android System WebView marker.
  if (/;\s*wv\)/.test(ua)) return true;

  // 4. iOS WKWebView heuristic: AppleWebKit, no "Safari", and not a known real
  //    third-party iOS browser (Chrome/Firefox/Edge include CriOS/FxiOS/EdgiOS).
  //    Standalone PWA already excluded above.
  if (
    /iPhone|iPad|iPod/.test(ua) &&
    /AppleWebKit/.test(ua) &&
    !/Safari/.test(ua) &&
    !/CriOS|FxiOS|EdgiOS/.test(ua)
  ) {
    return true;
  }

  return false;
}

/**
 * Should we block the app and show the "open in browser" screen? True when an
 * in-app browser is detected, or when the hard requirement — a service worker
 * (the entire SPA shell depends on it) — is unavailable.
 */
export function shouldBlockInAppBrowser(): boolean {
  if (typeof window === "undefined") return false;
  if (isStandalone()) return false;
  return isInAppBrowser() || !("serviceWorker" in navigator);
}
