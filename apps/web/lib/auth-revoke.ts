import { and, eq, inArray, isNull } from "drizzle-orm";
import { sessions, users } from "@legends/db/schema";
import { REDIS_KEYS } from "@legends/shared";
import { db } from "./db";
import { redis } from "./redis";

const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);

async function revokeJtiBatch(rows: Array<{ accessJti: string | null; accessExpiresAt: Date | null }>): Promise<void> {
  if (rows.length === 0) return;
  const nowMs = Date.now();
  const pipe = redis.pipeline();
  for (const r of rows) {
    if (!r.accessJti) continue;
    const remainingMs = r.accessExpiresAt ? r.accessExpiresAt.getTime() - nowMs : ACCESS_TTL * 1000;
    const ttl = Math.max(1, Math.ceil(remainingMs / 1000));
    pipe.set(REDIS_KEYS.REVOKED_JTI(r.accessJti), "1", "EX", ttl);
  }
  await pipe.exec();
}

export async function revokeUserJtis(userId: string): Promise<void> {
  const rows = await db
    .select({ accessJti: sessions.accessJti, accessExpiresAt: sessions.accessExpiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await revokeJtiBatch(rows);
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function revokeJtisForRole(role: string): Promise<void> {
  const userRows = await db.select({ id: users.id }).from(users).where(eq(users.role, role));
  if (userRows.length === 0) return;
  const ids = userRows.map((r) => r.id);
  const rows = await db
    .select({ accessJti: sessions.accessJti, accessExpiresAt: sessions.accessExpiresAt })
    .from(sessions)
    .where(and(inArray(sessions.userId, ids), isNull(sessions.revokedAt)));
  await revokeJtiBatch(rows);
  await db.delete(sessions).where(inArray(sessions.userId, ids));
}
