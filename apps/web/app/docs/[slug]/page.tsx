import fs from "fs";
import path from "path";
import { notFound, redirect } from "next/navigation";
import { marked } from "marked";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";

marked.setOptions({ gfm: true, breaks: true });

const DOCS: Record<string, { title: string; public: boolean; adminOnly: boolean }> = {
  whitepaper: { title: "Privacy & Security Whitepaper", public: true, adminOnly: false },
  manual: { title: "User Manual", public: false, adminOnly: false },
  "admin-manual": { title: "Administrator Manual", public: false, adminOnly: true },
};

function resolveDocsPath(filename: string): string | null {
  const candidates = [
    path.join(process.cwd(), "public", "docs", filename),
    path.join(process.cwd(), "apps", "web", "public", "docs", filename),
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch { /* try next */ }
  }
  return null;
}

export async function generateStaticParams() {
  return [{ slug: "whitepaper" }];
}

export default async function DocsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = DOCS[slug];
  if (!meta) notFound();

  if (!meta.public) {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    if (meta.adminOnly && user.role === "user") redirect("/");
  }

  const filePath = resolveDocsPath(`${slug}.md`);
  if (!filePath) notFound();

  let markdown: string;
  try {
    markdown = fs.readFileSync(filePath, "utf-8");
  } catch {
    notFound();
  }

  const html = marked.parse(markdown) as string;

  return (
    <main className="selectable fixed inset-0 overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-[calc(2.5rem+var(--sat))]">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text transition"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </Link>
        <article
          className="prose prose-invert max-w-none
            prose-headings:font-semibold prose-headings:text-text
            prose-h1:text-2xl prose-h1:mb-4
            prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-3 prose-h2:border-b prose-h2:border-border prose-h2:pb-2
            prose-h3:text-base prose-h3:mt-6 prose-h3:mb-2
            prose-p:text-muted prose-p:leading-relaxed
            prose-a:text-accent2 prose-a:no-underline hover:prose-a:underline
            prose-strong:text-text prose-strong:font-semibold
            prose-code:text-accent prose-code:bg-panel2 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono
            prose-pre:bg-panel2 prose-pre:border prose-pre:border-border prose-pre:rounded-xl
            prose-blockquote:border-l-accent2 prose-blockquote:text-muted prose-blockquote:not-italic
            prose-table:text-sm prose-th:text-text prose-th:font-semibold prose-td:text-muted
            prose-hr:border-border
            prose-li:text-muted prose-li:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </main>
  );
}
