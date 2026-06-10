"use client";

import { useEffect, useState } from "react";
import { Pencil, Trash2, Check, X } from "lucide-react";

interface CustomGif {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  title: string;
  tags: string[];
  createdAt: string;
}

export function AdminGifsView() {
  const [gifs, setGifs] = useState<CustomGif[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/gif/custom?limit=100")
      .then((r) => r.json())
      .then((d: { gifs: CustomGif[] }) => setGifs(d.gifs ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function startEdit(g: CustomGif) {
    setEditingId(g.id);
    setEditTitle(g.title);
    setEditTags(g.tags.join(", "));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/gif/custom/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });
      const d = await res.json() as { gif: CustomGif };
      if (res.ok) {
        setGifs((prev) => prev.map((g) => g.id === id ? d.gif : g));
        setEditingId(null);
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteGif(id: string) {
    if (!confirm("Delete this GIF?")) return;
    const res = await fetch(`/api/gif/custom/${id}`, { method: "DELETE" });
    if (res.ok) setGifs((prev) => prev.filter((g) => g.id !== id));
  }

  return (
    <section className="flex-1 p-4 sm:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">GIF Library</h1>
        <p className="mt-1 text-sm text-muted">{gifs.length} uploaded GIFs. Edit titles and search tags.</p>
      </div>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {!loading && gifs.length === 0 && (
        <p className="text-muted text-sm">No GIFs uploaded yet. Users with the <code className="bg-panel2 px-1 rounded">content.gif.upload</code> permission can upload from the GIF picker.</p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {gifs.map((g) => (
          <div key={g.id} className="rounded-xl border border-border bg-panel overflow-hidden">
            <div className="aspect-square overflow-hidden bg-panel2">
              <img
                src={g.thumbnailUrl ?? g.url}
                alt={g.title || "GIF"}
                className="h-full w-full object-cover"
              />
            </div>

            {editingId === g.id ? (
              <div className="p-2 space-y-1.5">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Title"
                  className="w-full rounded border border-border bg-panel2 px-2 py-1 text-xs outline-none focus:border-accent"
                />
                <input
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="Tags (comma separated)"
                  className="w-full rounded border border-border bg-panel2 px-2 py-1 text-xs outline-none focus:border-accent"
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => saveEdit(g.id)}
                    disabled={saving}
                    className="flex-1 flex items-center justify-center gap-1 rounded bg-accent px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" /> Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="flex items-center justify-center rounded border border-border px-2 py-1 text-xs hover:bg-panel2"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-2">
                <p className="truncate text-xs font-medium">{g.title || <span className="text-muted italic">untitled</span>}</p>
                {g.tags.length > 0 && (
                  <p className="truncate text-[10px] text-muted mt-0.5">{g.tags.join(", ")}</p>
                )}
                <div className="mt-1.5 flex gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(g)}
                    className="flex flex-1 items-center justify-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-panel2"
                  >
                    <Pencil className="h-3 w-3" /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteGif(g.id)}
                    className="flex items-center justify-center rounded border border-danger/40 px-2 py-1 text-xs text-danger hover:bg-danger/10"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
