"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink as ExternalLinkIcon } from "lucide-react";
import { useExternalLink } from "@/contexts/ExternalLinkContext";
import { cn } from "@/lib/cn";

interface Anchor {
  x: number;
  y: number;
  href: string;
  /** True when the URL is same-origin and we should hand off to Next router. */
  internal: boolean;
}

/**
 * Document-level right-click handler for `<a href>` elements. Renders a small
 * popover with "Copy link" + "Open link" at the cursor. Replaces the native
 * browser right-click menu on anchors — the global preventDefault in the
 * pre-React boot script already suppresses native menus everywhere, this just
 * gives the user back the two affordances that matter on links.
 */
export function LinkContextMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const { requestOpen } = useExternalLink();
  const router = useRouter();

  useEffect(() => {
    function isInternal(absoluteHref: string): boolean {
      try {
        const u = new URL(absoluteHref);
        return u.origin === window.location.origin;
      } catch {
        return false;
      }
    }

    function onContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const a = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const absolute = a.href;
      // Skip empty / javascript: / data: / mailto: / tel: — popover would be
      // useless. Let the global preventDefault still suppress native menu;
      // the user just sees nothing, which is fine for these schemes.
      if (!absolute) return;
      if (!/^https?:\/\//i.test(absolute)) return;
      e.preventDefault();
      setAnchor({
        x: e.clientX,
        y: e.clientY,
        href: absolute,
        internal: isInternal(absolute),
      });
    }

    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Esc closes.
  useEffect(() => {
    if (!anchor) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAnchor(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchor]);

  if (!anchor) return null;

  const W = 200;
  const H = 78;
  const x = Math.min(anchor.x, window.innerWidth - W - 8);
  const y = Math.min(anchor.y, window.innerHeight - H - 8);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(anchor!.href);
    } catch {
      // Older browsers / non-secure contexts — best-effort fallback.
      const ta = document.createElement("textarea");
      ta.value = anchor!.href;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    setAnchor(null);
  }

  function openLink() {
    const href = anchor!.href;
    setAnchor(null);
    if (anchor!.internal) {
      // Same-origin → SPA navigation, no shell remount.
      try {
        const u = new URL(href);
        router.push(u.pathname + u.search + u.hash);
      } catch {
        router.push(href);
      }
      return;
    }
    requestOpen(href);
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9989]"
        onMouseDown={() => setAnchor(null)}
        onContextMenu={(e) => { e.preventDefault(); setAnchor(null); }}
      />
      <div
        role="menu"
        className="fixed z-[9998] w-[200px] overflow-hidden rounded-md border border-border bg-panel py-1 shadow-lg"
        style={{ top: y, left: x }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={copyLink}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-text transition hover:bg-panel2",
          )}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" />
          Copy link
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={openLink}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-text transition hover:bg-panel2",
          )}
        >
          <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0" />
          {anchor.internal ? "Open" : "Open link"}
        </button>
      </div>
    </>,
    document.body,
  );
}
