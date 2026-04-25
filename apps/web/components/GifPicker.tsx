"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

interface GifResult {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
}

interface Props {
  onSelect: (gif: { url: string; thumbnailUrl: string; width: number; height: number }) => void;
  onClose: () => void;
}

export function GifPicker({ onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function search(q: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/gif?q=${encodeURIComponent(q)}&limit=20`);
      const data = await res.json() as { gifs?: GifResult[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "failed");
      setGifs(data.gifs ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    search("");
  }, []);

  function handleQueryChange(q: string) {
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(q), 400);
  }

  return (
    <div className="absolute bottom-full left-0 z-40 mb-2 w-80 rounded-xl border border-border bg-panel shadow-xl">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search GIFs…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
        <button type="button" onClick={onClose} className="text-muted hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="h-64 overflow-y-auto p-2">
        {loading && <p className="py-8 text-center text-xs text-muted">Loading…</p>}
        {error && <p className="py-8 text-center text-xs text-danger">{error}</p>}
        {!loading && !error && gifs.length === 0 && (
          <p className="py-8 text-center text-xs text-muted">No results</p>
        )}
        <div className="grid grid-cols-2 gap-1">
          {gifs.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelect({ url: g.url, thumbnailUrl: g.thumbnailUrl, width: g.width, height: g.height })}
              className="overflow-hidden rounded-lg hover:opacity-90"
            >
              <img
                src={g.thumbnailUrl}
                alt={g.title}
                className="h-24 w-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border px-3 py-1.5 text-center text-[10px] text-muted">
        Powered by GIPHY
      </div>
    </div>
  );
}
