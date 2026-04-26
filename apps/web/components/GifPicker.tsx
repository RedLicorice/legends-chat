"use client";

import { useEffect, useRef, useState } from "react";
import { Search, X, Upload, Plus, Check, ArrowLeft } from "lucide-react";

interface GifResult {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
}

interface CustomGif {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  title: string;
  tags: string[];
}

interface Props {
  onSelect: (gif: { url: string; thumbnailUrl: string; width: number; height: number }) => void;
  onClose: () => void;
  canUploadGif?: boolean;
  giphyEnabled?: boolean;
}

type Tab = "library" | "giphy";

export function GifPicker({ onSelect, onClose, canUploadGif, giphyEnabled }: Props) {
  const [tab, setTab] = useState<Tab>("library");

  return (
    <div className="absolute bottom-full left-0 z-40 mb-2 w-80 rounded-xl border border-border bg-panel shadow-xl">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border">
        <button
          type="button"
          onClick={() => setTab("library")}
          className={`flex-1 py-2 text-xs font-medium transition ${tab === "library" ? "text-text border-b-2 border-accent" : "text-muted hover:text-text"}`}
        >
          Library
        </button>
        {giphyEnabled && (
          <button
            type="button"
            onClick={() => setTab("giphy")}
            className={`flex-1 py-2 text-xs font-medium transition ${tab === "giphy" ? "text-text border-b-2 border-accent" : "text-muted hover:text-text"}`}
          >
            GIPHY
          </button>
        )}
        <button type="button" onClick={onClose} className="px-3 text-muted hover:text-text">
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === "library" ? (
        <LibraryTab onSelect={onSelect} canUploadGif={canUploadGif} />
      ) : (
        <GiphyTab onSelect={onSelect} />
      )}
    </div>
  );
}

function LibraryTab({
  onSelect,
  canUploadGif,
}: {
  onSelect: Props["onSelect"];
  canUploadGif?: boolean;
}) {
  const [gifs, setGifs] = useState<CustomGif[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load(q: string) {
    setLoading(true);
    const qs = q ? `?q=${encodeURIComponent(q)}&limit=50` : "?limit=50";
    fetch(`/api/gif/custom${qs}`)
      .then((r) => r.json())
      .then((d: { gifs: CustomGif[] }) => setGifs(d.gifs ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(""); }, []);

  function handleQuery(q: string) {
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => load(q), 350);
  }

  if (showUpload) {
    return (
      <UploadForm
        onDone={(gif) => {
          setGifs((prev) => [gif, ...prev]);
          setShowUpload(false);
        }}
        onCancel={() => setShowUpload(false)}
      />
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => handleQuery(e.target.value)}
          placeholder="Search library…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
        {canUploadGif && (
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            title="Upload GIF"
            className="text-muted hover:text-accent transition"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="h-64 overflow-y-auto p-2">
        {loading && <p className="py-8 text-center text-xs text-muted">Loading…</p>}
        {!loading && gifs.length === 0 && (
          <p className="py-8 text-center text-xs text-muted">
            {query ? "No results" : "No GIFs uploaded yet"}
          </p>
        )}
        <div className="grid grid-cols-2 gap-1">
          {gifs.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() =>
                onSelect({ url: g.url, thumbnailUrl: g.thumbnailUrl ?? g.url, width: 0, height: 0 })
              }
              className="overflow-hidden rounded-lg hover:opacity-90"
            >
              <img
                src={g.thumbnailUrl ?? g.url}
                alt={g.title || "GIF"}
                className="h-24 w-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function GiphyTab({ onSelect }: { onSelect: Props["onSelect"] }) {
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

  useEffect(() => { search(""); }, []);

  function handleQuery(q: string) {
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(q), 400);
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-2">
        <Search className="h-4 w-4 shrink-0 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => handleQuery(e.target.value)}
          placeholder="Search GIPHY…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
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
              <img src={g.thumbnailUrl} alt={g.title} className="h-24 w-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-border px-3 py-1.5 text-center text-[10px] text-muted">
        Powered by GIPHY
      </div>
    </>
  );
}

function UploadForm({
  onDone,
  onCancel,
}: {
  onDone: (gif: CustomGif) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File | null) {
    setFile(f);
    if (f) {
      const url = URL.createObjectURL(f);
      setPreview(url);
      if (!title) setTitle(f.name.replace(/\.gif$/i, ""));
    } else {
      setPreview(null);
    }
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const upRes = await fetch("/api/upload?bucket=gifs", { method: "POST", body: fd });
      const upData = await upRes.json() as { url?: string; error?: string };
      if (!upRes.ok) throw new Error(upData.error ?? "upload failed");

      const gifRes = await fetch("/api/gif/custom", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: upData.url,
          title: title.trim(),
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const gifData = await gifRes.json() as { gif?: CustomGif; error?: string };
      if (!gifRes.ok) throw new Error(gifData.error ?? "save failed");
      onDone(gifData.gif!);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onCancel} className="text-muted hover:text-text">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-xs font-medium">Upload GIF</span>
      </div>

      {preview ? (
        <div className="relative">
          <img src={preview} alt="preview" className="h-32 w-full rounded-lg object-contain bg-panel2" />
          <button
            type="button"
            onClick={() => { setFile(null); setPreview(null); }}
            className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-24 w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-xs text-muted hover:border-accent hover:text-accent transition"
        >
          <Upload className="h-4 w-4" /> Select GIF
        </button>
      )}
      <input ref={fileRef} type="file" accept="image/gif" className="hidden" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        maxLength={120}
        className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="Tags (comma separated)"
        className="w-full rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
      />

      {error && <p className="text-xs text-danger">{error}</p>}

      <button
        type="button"
        onClick={upload}
        disabled={!file || uploading}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {uploading ? "Uploading…" : <><Check className="h-4 w-4" /> Upload</>}
      </button>
    </div>
  );
}
