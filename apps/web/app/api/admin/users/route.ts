import { and, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { userBans, userMutes, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      isAnon: users.isAnon,
      telegramUsername: users.telegramUsername,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      q
        ? or(
            ilike(users.displayName, `%${q}%`),
            ilike(users.telegramUsername, `%${q}%`),
          )
        : undefined,
    )
    .orderBy(users.displayName)
    .limit(100);

  if (rows.length === 0) return NextResponse.json([]);

  const userIds = rows.map((r) => r.id);
  const now = sql`NOW()`;

  const [activeBans, activeMutes] = await Promise.all([
    db
      .select({ userId: userBans.userId, expiresAt: userBans.expiresAt })
      .from(userBans)
      .where(and(inArray(userBans.userId, userIds), isNull(userBans.liftedAt), or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now)))),
    db
      .select({ userId: userMutes.userId, expiresAt: userMutes.expiresAt })
      .from(userMutes)
      .where(and(inArray(userMutes.userId, userIds), isNull(userMutes.liftedAt), or(isNull(userMutes.expiresAt), gt(userMutes.expiresAt, now)))),
  ]);

  const bannedMap = new Map(activeBans.map((b) => [b.userId, b.expiresAt?.toISOString() ?? null]));
  const mutedMap = new Map(activeMutes.map((m) => [m.userId, m.expiresAt?.toISOString() ?? null]));

  return NextResponse.json(
    rows.map((r) => ({
      ...r,
      isBanned: bannedMap.has(r.id),
      banExpiresAt: bannedMap.get(r.id) ?? null,
      isMuted: mutedMap.has(r.id),
      muteExpiresAt: mutedMap.get(r.id) ?? null,
    })),
  );
}
