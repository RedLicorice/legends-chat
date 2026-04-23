import { NextResponse } from "next/server";
import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import { messages, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const [topic] = await db.select().from(topics).where(eq(topics.id, id)).limit(1);
  if (!topic) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (topic.autoDeleteMode === "none") {
    return NextResponse.json({ deleted: 0 });
  }

  let deleted = 0;

  if (topic.autoDeleteMode === "age" && topic.autoDeleteAgeSeconds) {
    const cutoff = new Date(Date.now() - topic.autoDeleteAgeSeconds * 1000);
    const result = await db
      .delete(messages)
      .where(and(eq(messages.topicId, id), lt(messages.createdAt, cutoff)))
      .returning({ id: messages.id });
    deleted = result.length;
  } else if (topic.autoDeleteMode === "count" && topic.autoDeleteMaxMessages) {
    // Keep the last N messages; hard-delete the rest.
    const keep = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.topicId, id))
      .orderBy(sql`${messages.id} DESC`)
      .limit(topic.autoDeleteMaxMessages);

    if (keep.length > 0) {
      const keepIds = keep.map((r) => r.id);
      const result = await db
        .delete(messages)
        .where(and(eq(messages.topicId, id), notInArray(messages.id, keepIds)))
        .returning({ id: messages.id });
      deleted = result.length;
    }
  }

  return NextResponse.json({ deleted });
}
