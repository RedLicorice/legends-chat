import { NextResponse } from "next/server";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAllSettings, setSetting } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { asc } from "drizzle-orm";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [settings, topicList] = await Promise.all([
    getAllSettings(db),
    db.select({ id: topics.id, title: topics.title, slug: topics.slug }).from(topics).orderBy(asc(topics.sortOrder)),
  ]);

  return NextResponse.json({ settings, topics: topicList });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json() as Record<string, string | null>;
  const allowed = [
    "default_topic_id",
    "welcome_message",
    "farewell_message",
    "community_name",
    "community_logo_url",
    "community_banner_url",
    "registration_mode",
  ] as const;

  for (const key of allowed) {
    if (key in body) {
      const val = body[key];
      await setSetting(db, key, val ?? null);
    }
  }

  return NextResponse.json({ ok: true });
}
