import { writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

const UPLOAD_DIR = join(process.cwd(), "public", "uploads");
const AVATAR_DIR = join(UPLOAD_DIR, "avatars");
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const bucket = (form.get("bucket") as string | null) ?? "uploads";

  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (!ALLOWED_TYPES.has(file.type)) return NextResponse.json({ error: "unsupported type" }, { status: 400 });
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "file too large" }, { status: 400 });

  const ext = extname(file.name) || ".jpg";
  const name = `${randomUUID()}${ext}`;
  const dir = bucket === "avatars" ? AVATAR_DIR : UPLOAD_DIR;
  const dest = join(dir, name);

  const bytes = await file.arrayBuffer();
  await writeFile(dest, Buffer.from(bytes));

  const url = bucket === "avatars" ? `/uploads/avatars/${name}` : `/uploads/${name}`;
  return NextResponse.json({ url });
}
