import { NextResponse, type NextRequest } from "next/server";
import { topics } from "@legends/db/schema";
import { createTopicSchema, PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

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
  const [row] = await db
    .insert(topics)
    .values({
      slug: parsed.data.slug,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      isSticky: parsed.data.isSticky,
      sortOrder: parsed.data.sortOrder,
      isE2ee: parsed.data.isE2ee,
      historyVisibleToNewMembers: parsed.data.historyVisibleToNewMembers,
      autoDeleteMode: parsed.data.autoDeleteMode,
      autoDeleteAgeSeconds: parsed.data.autoDeleteAgeSeconds ?? null,
      autoDeleteMaxMessages: parsed.data.autoDeleteMaxMessages ?? null,
    })
    .returning();
  return NextResponse.json({ topic: row });
}
