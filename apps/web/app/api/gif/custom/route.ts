import { NextResponse } from "next/server";
import { ilike, or, sql, desc } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { customGifs } from "@legends/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Number(searchParams.get("limit") ?? 30), 100);

  const rows = q
    ? await db.select().from(customGifs)
        .where(
          or(
            ilike(customGifs.title, `%${q}%`),
            sql`EXISTS (SELECT 1 FROM unnest(${customGifs.tags}) tag WHERE tag ILIKE ${`%${q}%`})`,
          ),
        )
        .orderBy(desc(customGifs.createdAt))
        .limit(limit)
    : await db.select().from(customGifs)
        .orderBy(desc(customGifs.createdAt))
        .limit(limit);

  return NextResponse.json({ gifs: rows });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.CONTENT_GIF_UPLOAD)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json() as { url: string; thumbnailUrl?: string; title?: string; tags?: string[] };
  if (!body.url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const [row] = await db.insert(customGifs).values({
    url: body.url,
    thumbnailUrl: body.thumbnailUrl ?? null,
    title: body.title?.trim() ?? "",
    tags: (body.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    uploadedByUserId: user.id,
  }).returning();

  return NextResponse.json({ gif: row });
}
