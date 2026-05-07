"use client";

import { useEffect, useRef } from "react";
import { marked } from "marked";

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

// Walk text nodes and wrap #hashtags in styled spans (skip code/pre).
function applyHashtags(root: HTMLElement) {
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
    if (!/#[a-zA-Z]\w*/.test(textNode.nodeValue ?? "")) continue;
    const frag = document.createDocumentFragment();
    const parts = (textNode.nodeValue ?? "").split(/(#[a-zA-Z]\w*)/g);
    for (const part of parts) {
      if (/^#[a-zA-Z]\w*$/.test(part)) {
        const span = document.createElement("span");
        span.className = "hashtag-tag";
        span.textContent = part;
        frag.appendChild(span);
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

  useEffect(() => {
    if (!ref.current) return;
    const preprocessed = preprocessMentions(unescapeTiptapMarkdown(content));
    const html = marked.parse(preprocessed) as string;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((el) => el.remove());
    doc.querySelectorAll("[onclick],[onerror],[onload],[onmouseover]").forEach((el) => {
      ["onclick", "onerror", "onload", "onmouseover"].forEach((attr) => el.removeAttribute(attr));
    });
    // Force safe link attributes
    doc.querySelectorAll("a[href]").forEach((el) => {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    });
    ref.current.innerHTML = doc.body.innerHTML;
    applyHashtags(ref.current);
  }, [content]);

  return (
    <div
      ref={ref}
      className={`prose prose-sm prose-invert max-w-none ${className ?? ""}`}
    />
  );
}
