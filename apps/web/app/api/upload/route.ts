import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";
import { getAllSettings } from "@legends/db/system-settings";
import { db } from "@/lib/db";
import { hasImageMetadata } from "@/lib/image-metadata";
import { checkAndIncrement } from "@/lib/rate-limit";

const UPLOAD_DIR = process.env.NODE_ENV === "production"
  ? "/app/uploads"
  : join(process.cwd(), "public", "uploads");
const AVATAR_DIR = join(UPLOAD_DIR, "avatars");
const GIF_DIR = join(UPLOAD_DIR, "gifs");
const FILE_DIR = join(UPLOAD_DIR, "files");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function parseInt10(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const settings = await getAllSettings(db);
  const maxImageMb = parseInt10(settings.upload_max_size_image_mb, 10);
  const maxFileMb = parseInt10(settings.upload_max_size_file_mb, 50);
  const MAX_IMAGE_SIZE = maxImageMb * 1024 * 1024;
  const MAX_FILE_SIZE = maxFileMb * 1024 * 1024;
  const allowOriginal = (settings.upload_allow_original ?? "true") === "true";

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const bucket = (form.get("bucket") as string | null) ?? "uploads";
  const preserveOriginal = form.get("preserveOriginal") === "true";

  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  if (preserveOriginal && !allowOriginal) {
    return NextResponse.json({ error: "originals disabled" }, { status: 403 });
  }

  // Permission checks per bucket
  if (bucket === "avatars") {
    if (!IMAGE_TYPES.has(file.type)) return NextResponse.json({ error: "unsupported type" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: `file too large (max ${maxImageMb} MB)` }, { status: 400 });
  } else if (bucket === "gifs") {
    if (!user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (file.type !== "image/gif") return NextResponse.json({ error: "only GIF files allowed" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: `file too large (max ${maxImageMb} MB)` }, { status: 400 });
  } else {
    // images and files bucket — require CONTENT_ATTACHMENT
    if (!user.permissions.has(PERMISSIONS.CONTENT_ATTACHMENT)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (bucket === "uploads" && !IMAGE_TYPES.has(file.type)) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }
    const maxSize = bucket === "files" ? MAX_FILE_SIZE : MAX_IMAGE_SIZE;
    const maxMb = bucket === "files" ? maxFileMb : maxImageMb;
    if (file.size > maxSize) return NextResponse.json({ error: `file too large (max ${maxMb} MB)` }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());

  if (preserveOriginal) {
    // rate-limit native-resolution uploads (per-user, hour + day windows)
    const perHour = parseInt10(settings.upload_original_per_hour, 10);
    const perDay = parseInt10(settings.upload_original_per_day, 50);
    const hourKey = `upload:original:${user.id}:h:${Math.floor(Date.now() / 3600000)}`;
    const dayKey = `upload:original:${user.id}:d:${Math.floor(Date.now() / 86400000)}`;

    const hourRes = await checkAndIncrement(hourKey, perHour, 3600);
    if (!hourRes.allowed) {
      const retryAfter = Math.max(1, Math.ceil((hourRes.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "rate limit exceeded", scope: "hour", retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    const dayRes = await checkAndIncrement(dayKey, perDay, 86400);
    if (!dayRes.allowed) {
      const retryAfter = Math.max(1, Math.ceil((dayRes.resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "rate limit exceeded", scope: "day", retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  } else if (IMAGE_TYPES.has(file.type)) {
    // defense in depth: reject anything still carrying identifying metadata
    const meta = hasImageMetadata(buf, file.type);
    if (meta.found) {
      return NextResponse.json({ error: "image contains metadata", kinds: meta.kinds }, { status: 400 });
    }
  }

  const ext = extname(file.name) || ".bin";
  const name = `${randomUUID()}${ext}`;

  let dir: string;
  let urlPrefix: string;
  if (bucket === "avatars") { dir = AVATAR_DIR; urlPrefix = "/uploads/avatars"; }
  else if (bucket === "gifs") { dir = GIF_DIR; urlPrefix = "/uploads/gifs"; }
  else if (bucket === "files") { dir = FILE_DIR; urlPrefix = "/uploads/files"; }
  else { dir = UPLOAD_DIR; urlPrefix = "/uploads"; }

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), buf);

  return NextResponse.json({
    url: `${urlPrefix}/${name}`,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  });
}
