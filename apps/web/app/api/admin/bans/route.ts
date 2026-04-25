import { and, desc, eq, isNull, or, gt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { userBans, userMutes, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.USERS_BAN_DIRECT)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const now = new Date();
  const [bans, mutes] = await Promise.all([
    db
      .select({
        id: userBans.id,
        userId: userBans.userId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        reason: userBans.reason,
        createdAt: userBans.createdAt,
        expiresAt: userBans.expiresAt,
        liftedAt: userBans.liftedAt,
      })
      .from(userBans)
      .innerJoin(users, eq(userBans.userId, users.id))
      .where(and(isNull(userBans.liftedAt), or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now))))
      .orderBy(desc(userBans.createdAt))
      .limit(200),
    db
      .select({
        id: userMutes.id,
        userId: userMutes.userId,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        reason: userMutes.reason,
        createdAt: userMutes.createdAt,
        expiresAt: userMutes.expiresAt,
        liftedAt: userMutes.liftedAt,
      })
      .from(userMutes)
      .innerJoin(users, eq(userMutes.userId, users.id))
      .where(and(isNull(userMutes.liftedAt), or(isNull(userMutes.expiresAt), gt(userMutes.expiresAt, now))))
      .orderBy(desc(userMutes.createdAt))
      .limit(200),
  ]);

  return NextResponse.json({ bans, mutes });
}
