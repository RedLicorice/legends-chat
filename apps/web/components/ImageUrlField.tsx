"use client";
import { useState } from "react";
import { ImageUploadButton } from "@/components/ImageUploadButton";
import { ImageOff, Image } from "lucide-react";

interface Props {
  value: string;
  onChange: (url: string) => void;
  bucket?: string;
  accept?: string;
  hint?: string;
  placeholder?: string;
  className?: string;
}

const inputCls =
  "w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent";

export function ImageUrlField({
  value,
  onChange,
  bucket = "avatars",
  accept,
  hint,
  placeholder = "https://…",
  className,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);

  function handleChange(url: string) {
    setError(null);
    setPreviewBroken(false);
    onChange(url);
  }

  const previewBox = "mt-2 h-10 w-10 rounded border border-border bg-panel2 flex items-center justify-center";

  return (
    <div className={className}>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className={inputCls}
        />
        <ImageUploadButton
          bucket={bucket}
          accept={accept}
          onUploaded={(url) => handleChange(url)}
          onError={setError}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-50"
        />
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      <div className={previewBox}>
        {!value ? (
          <Image className="h-5 w-5 text-muted/40" />
        ) : previewBroken ? (
          <span title="Image URL is broken or unreachable"><ImageOff className="h-5 w-5 text-danger/60" /></span>
        ) : (
          <img
            key={value}
            src={value}
            alt="Preview"
            className="h-full w-full rounded object-cover"
            onError={() => setPreviewBroken(true)}
          />
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
