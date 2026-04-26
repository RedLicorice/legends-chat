import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { themes } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await db.select().from(themes).orderBy(asc(themes.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    id?: string;
    name: string;
    cloneFrom?: string;
    isGlass?: boolean;
    bgGradient?: string;
    colors?: Record<string, string>;
  };

  const id = (body.id ?? body.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!id || !body.name?.trim()) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }

  const existing = await db.select().from(themes).where(eq(themes.id, id)).limit(1);
  if (existing.length > 0) return NextResponse.json({ error: "id already exists" }, { status: 409 });

  let colors: Record<string, string> = body.colors ?? {};
  if (!Object.keys(colors).length && body.cloneFrom) {
    const src = await db.select().from(themes).where(eq(themes.id, body.cloneFrom)).limit(1);
    if (src[0]) colors = (src[0].colors as Record<string, string>) ?? {};
  }
  if (!Object.keys(colors).length) {
    colors = { bg:"11 13 18",panel:"20 24 33",panel2:"26 31 43",border:"38 45 59",text:"230 233 242",muted:"138 147 166",accent:"124 92 255",accent2:"92 200 255",danger:"255 92 124" };
  }

  const [row] = await db.insert(themes).values({
    id,
    name: body.name.trim(),
    isBuiltin: false,
    colors,
    isGlass: body.isGlass ?? false,
    bgGradient: body.bgGradient ?? null,
  }).returning();

  return NextResponse.json(row, { status: 201 });
}
