import { NextResponse, type NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { topics } from "@legends/db/schema";
import { createTopicSchema, PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await db
    .select({ id: topics.id, slug: topics.slug, title: topics.title })
    .from(topics)
    .orderBy(asc(topics.sortOrder), asc(topics.title));
  return NextResponse.json({ topics: rows });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.TOPICS_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createTopicSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  // Plan D constraint: E2EE topics cannot expose history to new joiners (we
  // can't share past Megolm sessions with users who weren't members when
  // they were created). The DB also enforces this via `topics_e2ee_history_chk`
  // — coercing here avoids surfacing a confusing 23514 to the client.
  const historyVisible = parsed.data.isE2ee
    ? false
    : parsed.data.historyVisibleToNewMembers;

  const [row] = await db
    .insert(topics)
    .values({
      slug: parsed.data.slug,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      isSticky: parsed.data.isSticky,
      sortOrder: parsed.data.sortOrder,
      isE2ee: parsed.data.isE2ee,
      historyVisibleToNewMembers: historyVisible,
      autoDeleteMode: parsed.data.autoDeleteMode,
      autoDeleteAgeSeconds: parsed.data.autoDeleteAgeSeconds ?? null,
      autoDeleteMaxMessages: parsed.data.autoDeleteMaxMessages ?? null,
    })
    .returning();
  return NextResponse.json({ topic: row });
}
