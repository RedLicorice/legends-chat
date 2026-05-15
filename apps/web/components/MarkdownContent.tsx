"use client";

import { useEffect, useRef } from "react";
import { marked } from "marked";
import { useSymbols } from "@/contexts/SymbolsContext";
import { useHashtagClick } from "@/contexts/HashtagClickContext";
import { useExternalLink } from "@/contexts/ExternalLinkContext";

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// tiptap-markdown escapes markdown special chars with backslash in paragraph
// nodes (e.g. "# heading" → "\# heading"). Unescape before passing to marked
// so headings, blockquotes, inline code, links etc. render correctly.
function unescapeTiptapMarkdown(s: string): string {
  return s.replace(/\\([*_~`#|>\[\]()\\])/g, "$1");
}

// Pre-process tiptap mention nodes ([@id="..." label="..."]) into styled spans
// before markdown parsing so marked doesn't escape the attributes.
function preprocessMentions(content: string): string {
  return content.replace(/\[@([^\]]*)\]/g, (_, attrs: string) => {
    const labelMatch = attrs.match(/label="([^"]*)"/);
    const label = escapeHtml(labelMatch?.[1] ?? "Unknown");
    return `<span class="mention-tag" data-mention="${label}">@${label}</span>`;
  });
}

// Walk text nodes and wrap #hashtags and known $symbols in styled spans (skip code/pre/a).
function applyTags(root: HTMLElement, isKnownSymbol: (s: string) => boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === "code" || tag === "pre" || tag === "a") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);

  for (const textNode of nodes) {
    const val = textNode.nodeValue ?? "";
    if (!/#[a-zA-Z]\w*|\$[a-zA-Z]\w*/.test(val)) continue;
    const frag = document.createDocumentFragment();
    const parts = val.split(/(#[a-zA-Z]\w*|\$[a-zA-Z]\w*)/g);
    for (const part of parts) {
      if (/^#[a-zA-Z]\w*$/.test(part)) {
        const span = document.createElement("span");
        span.className = "hashtag-tag cursor-pointer";
        span.setAttribute("data-tag", part);
        span.textContent = part;
        frag.appendChild(span);
      } else if (/^\$[a-zA-Z]\w*$/.test(part)) {
        const sym = part.slice(1).toLowerCase();
        if (isKnownSymbol(sym)) {
          const span = document.createElement("span");
          span.className = "symbol-tag cursor-pointer";
          span.setAttribute("data-tag", part);
          span.textContent = part;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

interface Props {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { isKnownSymbol } = useSymbols();
  const { onHashtagClick } = useHashtagClick();
  const { requestOpen } = useExternalLink();

  useEffect(() => {
    if (!ref.current) return;
    const preprocessed = preprocessMentions(unescapeTiptapMarkdown(content));
    const html = marked.parse(preprocessed) as string;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((el) => el.remove());
    doc.querySelectorAll("[onclick],[onerror],[onload],[onmouseover]").forEach((el) => {
      ["onclick", "onerror", "onload", "onmouseover"].forEach((attr) => el.removeAttribute(attr));
    });
    // Force safe link attributes. Strip every signal that could deanonymize
    // the chat origin to the external destination:
    //   rel=noopener     — destination cannot reach back via window.opener
    //   rel=noreferrer   — no Referer header sent (legacy + modern browsers)
    //   rel=nofollow     — destination not endorsed for SEO; also signals
    //                      "this URL is untrusted user content"
    //   referrerpolicy   — explicit override; outranks any global policy
    doc.querySelectorAll("a[href]").forEach((el) => {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
      el.setAttribute("referrerpolicy", "no-referrer");
    });
    ref.current.innerHTML = doc.body.innerHTML;
    applyTags(ref.current, isKnownSymbol);
  }, [content, isKnownSymbol]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      // Hashtags / symbols first
      const tagEl = (e.target as HTMLElement).closest("[data-tag]") as HTMLElement | null;
      if (tagEl) {
        const tag = tagEl.getAttribute("data-tag");
        if (tag) onHashtagClick(tag);
        return;
      }
      // External link interception — route http(s) anchors through the warning
      // dialog. Modifier-click (cmd/ctrl/shift/middle-click) bypasses so power
      // users can open in their preferred tab without nag.
      const link = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      const href = link.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(href)) return; // mailto/tel/internal-relative → let browser handle
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();
      requestOpen(href);
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [onHashtagClick, requestOpen]);

  return (
    <div
      ref={ref}
      className={`prose prose-sm prose-invert max-w-none ${className ?? ""}`}
    />
  );
}
