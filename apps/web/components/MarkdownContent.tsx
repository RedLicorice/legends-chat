"use client";

import { useEffect, useRef } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

interface Props {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const preprocessed = preprocessMentions(content);
    const html = marked.parse(preprocessed) as string;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((el) => el.remove());
    doc.querySelectorAll("[onclick],[onerror],[onload],[onmouseover]").forEach((el) => {
      ["onclick", "onerror", "onload", "onmouseover"].forEach((attr) => el.removeAttribute(attr));
    });
    ref.current.innerHTML = doc.body.innerHTML;
  }, [content]);

  return (
    <div
      ref={ref}
      className={`prose prose-sm prose-invert max-w-none ${className ?? ""}`}
    />
  );
}
