import { writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";

const UPLOAD_DIR = join(process.cwd(), "public", "uploads");
const AVATAR_DIR = join(UPLOAD_DIR, "avatars");
const GIF_DIR = join(UPLOAD_DIR, "gifs");
const FILE_DIR = join(UPLOAD_DIR, "files");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10 MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;   // 50 MB

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const bucket = (form.get("bucket") as string | null) ?? "uploads";

  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  // Permission checks per bucket
  if (bucket === "avatars") {
    if (!IMAGE_TYPES.has(file.type)) return NextResponse.json({ error: "unsupported type" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: "file too large (max 10 MB)" }, { status: 400 });
  } else if (bucket === "gifs") {
    if (!user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (file.type !== "image/gif") return NextResponse.json({ error: "only GIF files allowed" }, { status: 400 });
    if (file.size > MAX_IMAGE_SIZE) return NextResponse.json({ error: "file too large (max 10 MB)" }, { status: 400 });
  } else {
    // images and files bucket — require CONTENT_ATTACHMENT
    if (!user.permissions.has(PERMISSIONS.CONTENT_ATTACHMENT)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (bucket === "uploads" && !IMAGE_TYPES.has(file.type)) {
      return NextResponse.json({ error: "unsupported image type" }, { status: 400 });
    }
    const maxSize = bucket === "files" ? MAX_FILE_SIZE : MAX_IMAGE_SIZE;
    if (file.size > maxSize) return NextResponse.json({ error: `file too large (max ${bucket === "files" ? "50" : "10"} MB)` }, { status: 400 });
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
  await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));

  return NextResponse.json({
    url: `${urlPrefix}/${name}`,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
  });
}
