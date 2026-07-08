import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topicMembers, topics, users } from "@legends/db/schema";
import { canViewTopic } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasTopicPasswordProof } from "@/lib/topic-password";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

  // Same view gate as GET /api/topic/[slug] — don't leak the roster of a topic
  // the caller can't see. 404 (not 403) to avoid confirming the topic exists.
  const [topic] = await db
    .select({ viewRoles: topics.viewRoles, readRoles: topics.readRoles, passwordHash: topics.passwordHash, passwordVersion: topics.passwordVersion })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1);
  if (!topic) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!canViewTopic(user.role, topic.viewRoles as string[] | null, topic.readRoles as string[] | null)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Password gate (#19) — roster is topic content; don't leak it without the password.
  if (!(await hasTopicPasswordProof(user.role, user.id, topicId, topic.passwordHash, topic.passwordVersion))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      isAnon: users.isAnon,
      joinedAt: topicMembers.joinedAt,
    })
    .from(topicMembers)
    .innerJoin(users, eq(topicMembers.userId, users.id))
    .where(eq(topicMembers.topicId, topicId))
    .orderBy(users.displayName);

  return NextResponse.json(rows);
}
