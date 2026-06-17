import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PushSetup } from "@/components/PushSetup";
import { TokenRefresh } from "@/components/TokenRefresh";
import { SymbolsProvider } from "@/contexts/SymbolsContext";
import { SessionBootstrapProvider } from "@/contexts/SessionBootstrapContext";
import { ChatListProvider } from "@/contexts/ChatListContext";
import { ExternalLinkBootstrap } from "@/components/ExternalLinkBootstrap";
import { ExternalLinkDialog } from "@/components/ExternalLinkDialog";
import { LinkContextMenu } from "@/components/LinkContextMenu";
import { AppShell } from "@/components/AppShell";

// Strict-SPA root layout: pure, sync, no cookies(), no DB. Dynamic data
// (theme attributes, branding, external-link config) is resolved on the
// client so the catch-all SPA route's RSC reconciliation stays stable
// across navigations. Dynamic Metadata / Viewport still run server-side
// per request but live OUTSIDE the React tree so they don't affect router
// reconciliation.

// Mark static so Next caches the rendered tree; this keeps the catch-all
// route in the `(Static)` bucket instead of re-rendering RSC per request.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Legends Chat",
  description: "Community chat",
  // Browser-tab favicon + apple-touch icon both go through /api/favicon,
  // which 302s to the admin-configured pwa_icon_url (or the placeholder when
  // unset). Static metadata can't read the DB; the redirect route can.
  icons: {
    icon: [{ url: "/api/favicon" }],
    apple: [{ url: "/api/favicon" }],
  },
  appleWebApp: {
    capable: true,
    title: "Legends Chat",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d12",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Inline pre-React script: reads the theme + sidebar-compact preference from
// cookies (set by the client when the user changes them) and applies the
// matching data-* attributes on <html> before any CSS evaluates. Avoids the
// flash-of-default-theme on cold load and keeps the layout side-effect-free
// on the server.
const PRE_REACT_BOOT_SCRIPT = `
(function () {
  try {
    var c = document.cookie || "";
    function get(name) {
      var m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
    var theme = get("lc_theme");
    var sc = get("lc_sidebar_compact");
    var root = document.documentElement;
    if (theme) root.setAttribute("data-theme", theme);
    if (sc) root.setAttribute("data-sidebar-compact", sc);
  } catch (e) {}
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturechange", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gestureend", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("touchmove", function (e) { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // Suppress the native right-click menu everywhere. Components that want to
  // own the context menu (e.g. the chat bubble) call preventDefault in their
  // own onContextMenu handler during the target/capture phase before this
  // bubble-phase listener fires; preventDefault here just keeps the browser
  // chrome from appearing on everything else.
  document.addEventListener("contextmenu", function (e) { e.preventDefault(); }, { passive: false });

  // Stale-SW self-heal: ChunkLoadError fires when the SW serves a cached
  // shell that references _next chunk hashes the current server no longer
  // ships (typical after a deploy if the SW didn't refresh). Catch the
  // first occurrence per page session, drop SW + caches, then hard-reload
  // with a cache-bust query so the browser fetches a fresh shell.
  var didChunkReload = false;
  function onChunkError(ev) {
    var msg = (ev && (ev.reason && ev.reason.name || ev.error && ev.error.name) || "") + " " + (ev && (ev.message || (ev.reason && ev.reason.message) || (ev.error && ev.error.message)) || "");
    if (msg.indexOf("ChunkLoadError") === -1 && msg.indexOf("Loading chunk") === -1) return;
    if (didChunkReload) return;
    didChunkReload = true;
    try { sessionStorage.setItem("legends:chunk-error-reload", String(Date.now())); } catch (e) {}
    (async function () {
      try {
        if ("serviceWorker" in navigator) {
          var regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(function (r) { return r.unregister(); }));
        }
        if ("caches" in window) {
          var names = await caches.keys();
          await Promise.all(names.map(function (n) { return caches.delete(n); }));
        }
      } catch (e) {}
      var url = new URL(window.location.href);
      url.searchParams.set("_cb", Date.now().toString());
      window.location.replace(url.toString());
    })();
  }
  window.addEventListener("error", onChunkError);
  window.addEventListener("unhandledrejection", onChunkError);
})();
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      data-glass="0"
      data-sidebar-compact="minimal"
      suppressHydrationWarning
    >
      <head>
        <link rel="stylesheet" href="/api/theme.css" />
        <script dangerouslySetInnerHTML={{ __html: PRE_REACT_BOOT_SCRIPT }} />
      </head>
      <body className="bg-bg text-text">
        <SessionBootstrapProvider>
          <PushSetup />
          <TokenRefresh />
          <ExternalLinkBootstrap>
            <SymbolsProvider>
              <ChatListProvider>
                <AppShell>{children}</AppShell>
              </ChatListProvider>
            </SymbolsProvider>
            <ExternalLinkDialog />
            <LinkContextMenu />
          </ExternalLinkBootstrap>
        </SessionBootstrapProvider>
      </body>
    </html>
  );
}
