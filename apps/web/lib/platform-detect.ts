export type PlatformOpenResult =
  | { kind: "android"; intentUrl: string }
  | { kind: "ios-instructions" }
  | { kind: "redirect" };

export function openInBrowser(targetPath: string): PlatformOpenResult {
  if (typeof window === "undefined") return { kind: "redirect" };
  const ua = navigator.userAgent;
  // Substring "Android" alone matches some emulator / spoofed desktop UAs.
  // Require BOTH "Android" and "Mobile" so we never fire an intent:// from
  // a desktop browser (Chrome desktop has neither).
  const isAndroid = /android/i.test(ua) && /mobile/i.test(ua);
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isRealSafari = /Safari\//i.test(ua);
  const host = window.location.host;

  if (isAndroid) {
    const fallback = encodeURIComponent(`https://${host}${targetPath}`);
    const intent = `intent://${host}${targetPath}#Intent;scheme=https;S.browser_fallback_url=${fallback};end`;
    return { kind: "android", intentUrl: intent };
  }
  if (isIos && !isRealSafari) {
    // x-safari-https:// scheme attempted previously, but Telegram's iOS WebView
    // both stripped the prefix (navigating internally) AND handed off to Safari,
    // causing the token to be consumed twice — the second hit landed at
    // /login?error=invalid-token. Reverted to manual instructions only.
    return { kind: "ios-instructions" };
  }
  return { kind: "redirect" };
}
