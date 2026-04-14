import { and, desc, eq, isNull, or, gt } from "drizzle-orm";
import { userBans } from "@legends/db/schema";
import { formatDuration } from "@legends/shared";
import { db } from "./db";

export interface ActiveBan {
  reason: string;
  expiresAt: Date | null;
}

export async function getActiveBan(userId: string): Promise<ActiveBan | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, userId),
        isNull(userBans.liftedAt),
        or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now)),
      ),
    )
    .orderBy(desc(userBans.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { reason: row.reason, expiresAt: row.expiresAt };
}

export function formatBanMessage(ban: ActiveBan): string {
  if (ban.expiresAt === null) {
    return `🚫 You have been banned.\nReason: ${ban.reason}\nThis ban is permanent.`;
  }
  const remaining = ban.expiresAt.getTime() - Date.now();
  return `🚫 You have been banned.\nReason: ${ban.reason}\nTime remaining: ${formatDuration(remaining)}`;
}
