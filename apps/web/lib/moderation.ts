import { and, eq, isNull } from "drizzle-orm";
import { sessions, userBans, userMutes } from "@legends/db/schema";
import { REDIS_CHANNELS, REDIS_KEYS } from "@legends/shared";
import { db } from "./db.js";
import { redis } from "./redis.js";

export async function banUser(args: {
  userId: string;
  bannedByUserId: string;
  reason: string;
  expiresAt: Date | null;
  sourceFlagId?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(userBans).values({
      userId: args.userId,
      bannedByUserId: args.bannedByUserId,
      reason: args.reason,
      expiresAt: args.expiresAt,
      sourceFlagId: args.sourceFlagId ?? null,
    });
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, args.userId), isNull(sessions.revokedAt)));
  });
  await redis.set(REDIS_KEYS.BAN_CACHE(args.userId), "1", "EX", 60);
  await redis.publish(REDIS_CHANNELS.USER_BANNED, JSON.stringify({ userId: args.userId }));
}

export async function muteUser(args: {
  userId: string;
  mutedByUserId: string;
  reason: string;
  expiresAt: Date | null;
  sourceFlagId?: string | null;
}): Promise<void> {
  await db.insert(userMutes).values({
    userId: args.userId,
    mutedByUserId: args.mutedByUserId,
    reason: args.reason,
    expiresAt: args.expiresAt,
    sourceFlagId: args.sourceFlagId ?? null,
  });
  await redis.set(REDIS_KEYS.MUTE_CACHE(args.userId), "1", "EX", 60);
  await redis.publish(REDIS_CHANNELS.USER_MUTED, JSON.stringify({ userId: args.userId }));
}
