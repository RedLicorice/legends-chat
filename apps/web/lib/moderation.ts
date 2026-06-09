import { eq } from "drizzle-orm";
import { userBans, userMutes } from "@legends/db/schema";
import { REDIS_CHANNELS, REDIS_KEYS } from "@legends/shared";
import { db } from "./db";
import { redis } from "./redis";
import { revokeUserJtis } from "./auth-revoke";

export async function banUser(args: {
  userId: string;
  bannedByUserId: string;
  reason: string;
  expiresAt: Date | null;
  sourceFlagId?: string | null;
}): Promise<void> {
  await db.insert(userBans).values({
    userId: args.userId,
    bannedByUserId: args.bannedByUserId,
    reason: args.reason,
    expiresAt: args.expiresAt,
    sourceFlagId: args.sourceFlagId ?? null,
  });
  await revokeUserJtis(args.userId);
  await redis.set(REDIS_KEYS.BAN_CACHE(args.userId), "1", "EX", 60);
  await redis.publish(REDIS_CHANNELS.USER_BANNED, JSON.stringify({ userId: args.userId }));
}

export async function liftBan(banId: string, liftedByUserId: string): Promise<void> {
  const now = new Date();
  const [row] = await db
    .update(userBans)
    .set({ liftedAt: now, liftedByUserId })
    .where(eq(userBans.id, banId))
    .returning({ userId: userBans.userId });
  if (!row) return;
  await redis.del(REDIS_KEYS.BAN_CACHE(row.userId));
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
