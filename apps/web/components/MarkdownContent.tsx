"use client";

import { useEffect, useRef } from "react";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

interface Props {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const html = marked.parse(content) as string;
    // Sanitize using browser's built-in DOMParser to strip script tags
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
