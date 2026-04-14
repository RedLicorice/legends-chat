import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, gte, sql } from "drizzle-orm";
import { inviteCodes, inviteQuotaConfig } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function POST() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.INVITES_CREATE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [quota] = await db
    .select()
    .from(inviteQuotaConfig)
    .where(eq(inviteQuotaConfig.role, user.role))
    .limit(1);
  const dailyLimit = quota?.dailyLimit ?? 0;

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inviteCodes)
    .where(and(eq(inviteCodes.createdByUserId, user.id), gte(inviteCodes.createdAt, since)));

  if (Number(count) >= dailyLimit) {
    return NextResponse.json({ error: "daily invite quota reached" }, { status: 429 });
  }

  const code = randomBytes(6).toString("base64url").toUpperCase();
  const [row] = await db
    .insert(inviteCodes)
    .values({
      code,
      createdByUserId: user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning();
  return NextResponse.json({ invite: row });
}
