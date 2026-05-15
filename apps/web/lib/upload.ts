// Re-encode raster images via canvas to drop EXIF/XMP/ICC/GPS and any other
// metadata before bytes leave the device, and downscale to a sane resolution
// cap so 50 MP camera photos don't fill storage. JPEG/PNG only — GIF and
// animated WebP would lose animation through canvas, so they pass through
// (GIF/WebP containers carry no EXIF in practice).
const STRIP_TYPES = new Set(["image/jpeg", "image/png"]);

const DEFAULT_MAX_EDGE = 2560;
const DEFAULT_JPEG_QUALITY = 0.85;

export type UploadConfig = {
  uploadResizeCap: number;
  uploadJpegQuality: number;
  uploadMaxSizeImageMb: number;
  uploadAllowOriginal: boolean;
};

const FALLBACK_CONFIG: UploadConfig = {
  uploadResizeCap: DEFAULT_MAX_EDGE,
  uploadJpegQuality: DEFAULT_JPEG_QUALITY,
  uploadMaxSizeImageMb: 10,
  uploadAllowOriginal: true,
};

let configPromise: Promise<UploadConfig> | null = null;

export function fetchUploadConfig(): Promise<UploadConfig> {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const res = await fetch("/api/register-config", { credentials: "include" });
        if (!res.ok) return FALLBACK_CONFIG;
        const data = await res.json() as Partial<UploadConfig>;
        return {
          uploadResizeCap: typeof data.uploadResizeCap === "number" ? data.uploadResizeCap : FALLBACK_CONFIG.uploadResizeCap,
          uploadJpegQuality: typeof data.uploadJpegQuality === "number" ? data.uploadJpegQuality : FALLBACK_CONFIG.uploadJpegQuality,
          uploadMaxSizeImageMb: typeof data.uploadMaxSizeImageMb === "number" ? data.uploadMaxSizeImageMb : FALLBACK_CONFIG.uploadMaxSizeImageMb,
          uploadAllowOriginal: typeof data.uploadAllowOriginal === "boolean" ? data.uploadAllowOriginal : FALLBACK_CONFIG.uploadAllowOriginal,
        };
      } catch {
        return FALLBACK_CONFIG;
      }
    })();
  }
  return configPromise;
}

export type StripOptions = {
  maxEdge?: number;        // longest-edge resize cap in px; 0 disables resize
  jpegQuality?: number;    // 0..1
};

export async function stripImageMetadata(file: File, opts: StripOptions = {}): Promise<File> {
  if (!STRIP_TYPES.has(file.type)) return file;

  let maxEdge = opts.maxEdge;
  let qualityOpt = opts.jpegQuality;
  if (maxEdge === undefined || qualityOpt === undefined) {
    const cfg = await fetchUploadConfig();
    if (maxEdge === undefined) maxEdge = cfg.uploadResizeCap;
    if (qualityOpt === undefined) qualityOpt = cfg.uploadJpegQuality;
  }
  const quality = file.type === "image/jpeg" ? qualityOpt : undefined;

  const bitmap = await createImageBitmap(file);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = maxEdge > 0 && longest > maxEdge ? maxEdge / longest : 1;
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));

    let blob: Blob;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(targetW, targetH);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await canvas.convertToBlob({ type: file.type, quality });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
          file.type,
          quality,
        );
      });
    }

    return new File([blob], file.name, { type: file.type, lastModified: Date.now() });
  } finally {
    bitmap.close?.();
  }
}

export type UploadOptions = {
  preserveOriginal?: boolean;
};

export async function uploadFile(
  file: File,
  bucket: string,
  onProgress?: (pct: number) => void,
  opts: UploadOptions = {},
): Promise<string> {
  const preserveOriginal = opts.preserveOriginal === true;
  const safeFile = preserveOriginal ? file : await stripImageMetadata(file);
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", safeFile);
    form.append("bucket", bucket);
    if (preserveOriginal) form.append("preserveOriginal", "true");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.withCredentials = true;

    xhr.timeout = 120_000;
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("load", () => {
      try {
        const data = JSON.parse(xhr.responseText) as { url?: string; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          resolve(data.url);
        } else {
          reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error("Upload failed"));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));

    xhr.send(form);
  });
}
