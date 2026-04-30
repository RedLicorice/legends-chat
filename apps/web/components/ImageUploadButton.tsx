"use client";
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { uploadFile } from "@/lib/upload";

interface Props {
  onUploaded: (url: string) => void;
  onError?: (err: string) => void;
  bucket?: string;
  accept?: string;
  className?: string;
}

export function ImageUploadButton({
  onUploaded,
  onError,
  bucket = "avatars",
  accept = "image/jpeg,image/png,image/gif,image/webp",
  className,
}: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    setProgress(0);
    uploadFile(file, bucket, setProgress)
      .then((url) => { setProgress(null); onUploaded(url); })
      .catch((e: Error) => { setProgress(null); onError?.(e.message); });
  }

  const uploading = progress !== null;

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={uploading}
        title="Upload image"
        className={className ?? "flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2 disabled:opacity-50"}
      >
        <Upload className="h-4 w-4 shrink-0" />
        {uploading ? `${progress}%` : "Upload"}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { e.target.value = ""; handleFile(f); }
        }}
      />
    </>
  );
}
