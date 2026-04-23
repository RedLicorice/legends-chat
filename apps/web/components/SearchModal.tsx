"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";

interface SearchResult {
  id: string;
  topicId: string;
  topicTitle: string;
  topicSlug: string;
  senderDisplayName: string | null;
  createdAt: string;
}

interface SearchModalProps {
  onClose: () => void;
  currentTopicId?: string;
}

export function SearchModal({ onClose, currentTopicId }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.trim().length < 2) { setResults([]); setSearched(false); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query.trim() });
        if (currentTopicId) params.set("topic", currentTopicId);
        const res = await fetch(`/api/search?${params}`);
        const data = await res.json() as SearchResult[];
        setResults(Array.isArray(data) ? data : []);
        setSearched(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, currentTopicId]);

  function navigate(slug: string) {
    router.push(`/t/${slug}`);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-20 px-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-panel shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted" />
          ) : (
            <button type="button" onClick={onClose} className="text-muted hover:text-text">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {results.length > 0 ? (
          <ul className="max-h-80 overflow-y-auto divide-y divide-border">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => navigate(r.topicSlug)}
                  className="w-full px-4 py-3 text-left hover:bg-panel2 transition"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-accent2">#{r.topicTitle}</span>
                    <span className="text-xs text-muted">·</span>
                    <span className="text-xs text-muted">{r.senderDisplayName ?? "Unknown"}</span>
                    <span className="ml-auto text-xs text-muted">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="text-sm text-muted">Message #{r.id}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : searched && query.length >= 2 ? (
          <div className="px-4 py-6 text-center text-sm text-muted">No results found.</div>
        ) : null}

        {!currentTopicId && (
          <div className="border-t border-border px-4 py-2 text-xs text-muted">
            Searching all topics
          </div>
        )}
      </div>
    </div>
  );
}
