import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";
import { getAllSettings } from "@legends/db/system-settings";
import { uploads } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { hasImageMetadata, sniffImageMime } from "@/lib/image-metadata";
import { checkAndIncrement } from "@/lib/rate-limit";

const UPLOAD_DIR = process.env.NODE_ENV === "production"
  ? "/app/uploads"
  : join(process.cwd(), "public", "uploads");
const AVATAR_DIR = join(UPLOAD_DIR, "avatars");
const GIF_DIR = join(UPLOAD_DIR, "gifs");
const FILE_DIR = join(UPLOAD_DIR, "files");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Canonical extension per allowed image MIME. The stored extension is derived
// from the (server-validated) MIME — NEVER from the user filename — so an
// attacker can't get a `.html`/`.svg` file served inline from our origin.
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

// For the general `files` bucket (arbitrary attachments) we keep a plausible
// extension for the download, but only alphanumerics ≤12 chars — anything else
// becomes `.bin`. The real neutralizer for this bucket is nginx forcing
// `Content-Disposition: attachment` + `nosniff` so nothing ever executes inline.
function sanitizedExt(filename: string): string {
  const e = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(e) ? e : ".bin";
}

// The multipart part's Content-Type is attacker-controlled. We only ever use it
// as a *cheap pre-filter* and to cross-check against the sniffed type; every
// security decision (allowlist, stored extension, scanner dispatch) is made
// from `sniffImageMime` instead. Normalizing here means a browser that says
// `image/jpg` or appends a `;charset=` parameter still cross-checks cleanly.
function normalizeDeclaredMime(t: string): string {
  const base = (t || "").split(";")[0]!.trim().toLowerCase();
  return base === "image/jpg" ? "image/jpeg" : base;
}

function parseInt10(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function tooMany(scope: string, resetAt: number) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: "rate limit exceeded", scope, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

// Byte-volume counterpart to `checkAndIncrement` (which only counts requests).
// Reserve-then-release: we INCRBY first so concurrent uploads can't both slip
// under the cap, and give the bytes back when the reservation doesn't fit — a
// single oversized attempt must not burn the rest of the user's window.
async function reserveBytes(
  key: string,
  bytes: number,
  limitBytes: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; resetAt: number }> {
  const total = await redis.incrby(key, bytes);
  if (total === bytes) await redis.expire(key, windowSeconds);
  const ttl = await redis.ttl(key);
  const resetAt = Date.now() + (ttl > 0 ? ttl : windowSeconds) * 1000;
  if (total > limitBytes) {
    await redis.decrby(key, bytes);
    return { allowed: false, resetAt };
  }
  return { allowed: true, resetAt };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const settings = await getAllSettings(db);
  const maxImageMb = parseInt10(settings.upload_max_size_image_mb, 10);
  const maxFileMb = parseInt10(settings.upload_max_size_file_mb, 50);
  const MAX_IMAGE_SIZE = maxImageMb * 1024 * 1024;
  const MAX_FILE_SIZE = maxFileMb * 1024 * 1024;
  // cr-m6: defaults OFF. Metadata stripping is the headline privacy control;
  // an unset value must not mean "anyone may opt out of it".
  const allowOriginal = (settings.upload_allow_original ?? "false") === "true";

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const bucket = (form.get("bucket") as string | null) ?? "uploads";
  const isImageBucket = bucket === "avatars" || bucket === "gifs" || bucket === "uploads";

  // ── cr-m6: the EXIF/GPS opt-out is a privileged action ──────────────────────
  //
  // `preserveOriginal` was a bare client-controlled form field, on by default
  // globally, gated by nothing but a boolean setting — so on a stock deployment
  // any member could upload photos with full GPS/serial/timestamp intact and
  // every other member's browser would render them.
  //
  // It is only meaningful for the image buckets: the `files` bucket has no
  // stripping step to opt out of, and the client sends the flag there too, so
  // gating it unconditionally would break ordinary file attachments.
  const preserveOriginal = form.get("preserveOriginal") === "true" && isImageBucket;

  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  if (preserveOriginal) {
    if (!allowOriginal) {
      return NextResponse.json({ error: "originals disabled" }, { status: 403 });
    }
    if (!user.permissions.has(PERMISSIONS.CONTENT_UPLOAD_ORIGINAL)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const declaredType = normalizeDeclaredMime(file.type);

  // Permission checks per bucket. The MIME tests here are only a cheap
  // pre-filter so we don't buffer a 50 MB blob we're going to drop anyway —
  // the authoritative check is the magic-byte sniff below.
  if (bucket === "avatars") {
    if (!IMAGE_TYPES.has(declaredType)) return NextResponse.json({ error: "unsupported type" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: `file too large (max ${maxImageMb} MB)` }, { status: 400 });
  } else if (bucket === "gifs") {
    if (!user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (declaredType !== "image/gif") return NextResponse.json({ error: "only GIF files allowed" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: `file too large (max ${maxImageMb} MB)` }, { status: 400 });
  } else {
    // images and files bucket — require CONTENT_ATTACHMENT
    if (!user.permissions.has(PERMISSIONS.CONTENT_ATTACHMENT)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (bucket === "uploads" && !IMAGE_TYPES.has(declaredType)) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }
    const maxSize = bucket === "files" ? MAX_FILE_SIZE : MAX_IMAGE_SIZE;
    const maxMb = bucket === "files" ? maxFileMb : maxImageMb;
    if (file.size > maxSize) return NextResponse.json({ error: `file too large (max ${maxMb} MB)` }, { status: 400 });
  }

  // ── cr-h5: unconditional rate limit + storage quota ────────────────────────
  //
  // These checks used to live *inside* the `preserveOriginal` branch, so the
  // default path — every ordinary image and every files-bucket attachment —
  // had no per-user counter, no daily volume cap and no total quota. A user
  // with CONTENT_ATTACHMENT could loop 50 MB POSTs until the volume filled.
  //
  // Deliberately placed BEFORE `file.arrayBuffer()`: buffering first made the
  // route a memory amplifier under concurrency as well as a disk one.
  {
    const perHour = parseInt10(settings.upload_per_hour, 60);
    const perDay = parseInt10(settings.upload_per_day, 300);
    const bytesPerDay = parseInt10(settings.upload_bytes_per_day_mb, 512) * 1024 * 1024;
    const quotaBytes = parseInt10(settings.upload_quota_mb, 2048) * 1024 * 1024;
    const hourBucket = Math.floor(Date.now() / 3600000);
    const dayBucket = Math.floor(Date.now() / 86400000);

    const hourRes = await checkAndIncrement(`upload:count:${user.id}:h:${hourBucket}`, perHour, 3600);
    if (!hourRes.allowed) return tooMany("hour", hourRes.resetAt);
    const dayRes = await checkAndIncrement(`upload:count:${user.id}:d:${dayBucket}`, perDay, 86400);
    if (!dayRes.allowed) return tooMany("day", dayRes.resetAt);

    const volRes = await reserveBytes(
      `upload:bytes:${user.id}:d:${dayBucket}`,
      file.size,
      bytesPerDay,
      86400,
    );
    if (!volRes.allowed) return tooMany("daily-bytes", volRes.resetAt);

    // Cumulative on-disk footprint. `uploads` is the ledger written below; rows
    // tombstoned by the orphan sweeper no longer count against the quota.
    if (quotaBytes > 0) {
      const [usage] = await db
        .select({ total: sql<string>`coalesce(sum(${uploads.sizeBytes}), 0)` })
        .from(uploads)
        .where(and(eq(uploads.userId, user.id), isNull(uploads.deletedAt)));
      const used = Number(usage?.total ?? 0);
      if (used + file.size > quotaBytes) {
        return NextResponse.json(
          {
            error: "storage quota exceeded",
            usedBytes: used,
            quotaBytes,
          },
          { status: 413 },
        );
      }
    }
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // ── cr-c1: server-side container identification ────────────────────────────
  //
  // Previously the allowlist, the stored extension AND the choice of metadata
  // scanner all came from the client-declared MIME, and every scanner returned
  // "nothing found" when the bytes didn't match — so `Content-Type: image/png`
  // on a GPS-tagged JPEG bypassed EXIF stripping entirely and was stored as
  // `<uuid>.png`, which browsers happily decode as JPEG.
  //
  // Now: sniff the real container, require the declared type to agree, and use
  // the *sniffed* type for both the extension map and the scanner.
  let sniffed: string | null = null;
  let retainedMetadata: string[] = [];
  if (isImageBucket) {
    sniffed = sniffImageMime(buf);
    if (!sniffed || !IMAGE_TYPES.has(sniffed)) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }
    if (bucket === "gifs" && sniffed !== "image/gif") {
      return NextResponse.json({ error: "only GIF files allowed" }, { status: 400 });
    }
    if (sniffed !== declaredType) {
      return NextResponse.json(
        { error: "declared type does not match file contents", declared: declaredType, actual: sniffed },
        { status: 400 },
      );
    }

    // Fail closed. A container we can't walk cleanly is rejected regardless of
    // the preserve-original opt-out: that's a structural-integrity check, not a
    // privacy one, and legitimate uploads are freshly serialized by the client.
    const meta = hasImageMetadata(buf, sniffed);
    if (meta.malformed) {
      return NextResponse.json({ error: "unreadable image container", kinds: meta.kinds }, { status: 400 });
    }
    if (!preserveOriginal && meta.blocking) {
      return NextResponse.json({ error: "image contains metadata", kinds: meta.kinds }, { status: 400 });
    }
    // cr-m6: the scan now runs on the preserve-original path too, and what it
    // found is reported back to the uploader rather than silently skipped.
    retainedMetadata = meta.kinds;
  }

  if (preserveOriginal) {
    // Tighter secondary limit on native-resolution uploads, on top of the
    // unconditional limits above (per-user, hour + day windows).
    const perHour = parseInt10(settings.upload_original_per_hour, 10);
    const perDay = parseInt10(settings.upload_original_per_day, 50);
    const hourKey = `upload:original:${user.id}:h:${Math.floor(Date.now() / 3600000)}`;
    const dayKey = `upload:original:${user.id}:d:${Math.floor(Date.now() / 86400000)}`;

    const hourRes = await checkAndIncrement(hourKey, perHour, 3600);
    if (!hourRes.allowed) return tooMany("hour", hourRes.resetAt);
    const dayRes = await checkAndIncrement(dayKey, perDay, 86400);
    if (!dayRes.allowed) return tooMany("day", dayRes.resetAt);
  }

  // Image buckets (avatars/gifs/uploads) derive the extension from the SNIFFED
  // container, so the stored extension can never disagree with the bytes.
  // The files bucket keeps a sanitized ext and is download-forced by nginx.
  const ext = bucket === "files" ? sanitizedExt(file.name) : (MIME_EXT[sniffed ?? ""] ?? ".bin");
  const name = `${randomUUID()}${ext}`;

  let dir: string;
  let urlPrefix: string;
  let storagePrefix: string;
  if (bucket === "avatars") { dir = AVATAR_DIR; urlPrefix = "/uploads/avatars"; storagePrefix = "avatars/"; }
  else if (bucket === "gifs") { dir = GIF_DIR; urlPrefix = "/uploads/gifs"; storagePrefix = "gifs/"; }
  else if (bucket === "files") { dir = FILE_DIR; urlPrefix = "/uploads/files"; storagePrefix = "files/"; }
  else { dir = UPLOAD_DIR; urlPrefix = "/uploads"; storagePrefix = ""; }

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), buf);

  // Ledger row (cr-h5): backs the per-user quota above and tells the orphan
  // sweeper (scripts/sweep.ts) which files it is allowed to reclaim. Written
  // after the file so a failed write never inflates the quota.
  await db.insert(uploads).values({
    userId: user.id,
    bucket,
    url: `${urlPrefix}/${name}`,
    storagePath: `${storagePrefix}${name}`,
    mimeType: sniffed ?? declaredType ?? "application/octet-stream",
    sizeBytes: buf.length,
  });

  return NextResponse.json({
    url: `${urlPrefix}/${name}`,
    filename: file.name,
    // Report the server-verified type, not the client's claim.
    mimeType: sniffed ?? file.type,
    size: file.size,
    // Non-empty only on the preserve-original path; the default path rejects
    // instead of returning anything here.
    retainedMetadata,
  });
}
