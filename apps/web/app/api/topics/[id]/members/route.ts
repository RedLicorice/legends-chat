import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topicMembers, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

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
