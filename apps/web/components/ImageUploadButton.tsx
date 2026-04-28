"use client";
import { apiFetch } from "@/lib/fetch";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

interface Props {
  onUploaded: (url: string) => void;
  bucket?: string;
  className?: string;
}

export function ImageUploadButton({ onUploaded, bucket = "avatars", className }: Props) {
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("bucket", bucket);
      const res = await apiFetch("/api/upload", { method: "POST", body: form });
      const data = await res.json() as { url?: string };
      if (res.ok && data.url) onUploaded(data.url);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={uploading}
        title="Upload image"
        className={className ?? "flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-50"}
      >
        <Upload className="h-4 w-4" />
        {uploading ? "Uploading…" : "Upload"}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { e.target.value = ""; void handleFile(f); }
        }}
      />
    </>
  );
}
