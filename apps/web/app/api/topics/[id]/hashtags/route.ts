import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { topicMembers } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

  // Verify membership
  const [member] = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(
      and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, user.id),
      ),
    )
    .limit(1);
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await db.execute<{ tag: string; count: string }>(
    sql`
      SELECT tag, COUNT(*)::text AS count
      FROM messages, unnest(hashtags) AS tag
      WHERE topic_id = ${topicId}
        AND deleted_at IS NULL
        AND array_length(hashtags, 1) > 0
      GROUP BY tag
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `,
  );

  return NextResponse.json(
    Array.from(rows).map((r) => ({ tag: r.tag, count: Number(r.count) })),
  );
}
