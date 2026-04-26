import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { messages, topics, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// GET /api/search?q=hello&topic=topicId
// Full-text search over non-E2EE message content via tsvector.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const topicFilter = searchParams.get("topic");

  if (!q || q.length < 2) return NextResponse.json([]);

  // Build tsquery from user input — escape special chars, split words
  const tsQuery = q
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w}:*`)
    .join(" & ");

  if (!tsQuery) return NextResponse.json([]);

  const topicsAccessible = await db
    .select({ id: topics.id, title: topics.title, slug: topics.slug, isE2ee: topics.isE2ee })
    .from(topics);

  const allowedTopicIds = topicsAccessible
    .filter((t) => {
      if (t.isE2ee) return false;
      if (topicFilter && t.id !== topicFilter) return false;
      return true;
    })
    .map((t) => t.id);

  if (allowedTopicIds.length === 0) return NextResponse.json([]);

  const topicMap = Object.fromEntries(topicsAccessible.map((t) => [t.id, t]));

  const rows = await db
    .select({
      id: messages.id,
      topicId: messages.topicId,
      senderUserId: messages.senderUserId,
      senderDisplayName: users.displayName,
      senderAvatarUrl: users.avatarUrl,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(
      and(
        isNull(messages.deletedAt),
        inArray(messages.topicId, allowedTopicIds),
        sql`${messages.searchVector} @@ to_tsquery('english', ${tsQuery})`,
      ),
    )
    .orderBy(sql`ts_rank(${messages.searchVector}, to_tsquery('english', ${tsQuery})) DESC`)
    .limit(30);

  return NextResponse.json(
    rows.map((r) => {
      const t = topicMap[r.topicId];
      return {
        id: r.id.toString(),
        topicId: r.topicId,
        topicTitle: t?.title ?? "",
        topicSlug: t?.slug ?? "",
        senderUserId: r.senderUserId,
        senderDisplayName: r.senderDisplayName ?? null,
        senderAvatarUrl: r.senderAvatarUrl ?? null,
        createdAt: r.createdAt,
      };
    }),
  );
}
