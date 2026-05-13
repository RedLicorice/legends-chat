export type PlatformOpenResult =
  | { kind: "android"; intentUrl: string }
  | { kind: "ios-instructions" }
  | { kind: "redirect" };

export function openInBrowser(targetPath: string): PlatformOpenResult {
  if (typeof window === "undefined") return { kind: "redirect" };
  const ua = navigator.userAgent;
  const isAndroid = /android/i.test(ua);
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isRealSafari = /Safari\//i.test(ua);
  const host = window.location.host;

  if (isAndroid) {
    const fallback = encodeURIComponent(`https://${host}${targetPath}`);
    const intent = `intent://${host}${targetPath}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
    return { kind: "android", intentUrl: intent };
  }
  if (isIos && !isRealSafari) {
    return { kind: "ios-instructions" };
  }
  return { kind: "redirect" };
}
