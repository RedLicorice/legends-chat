import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens } from "@legends/db/schema";
import { db } from "./db";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const REUSE_WINDOW_MS = 15 * 1000;

/**
 * Issues a login token for a user with two safeguards:
 *   - If the user already has an active token issued within the last
 *     REUSE_WINDOW_MS, return that same token instead of minting a new one.
 *     This absorbs rapid /start retries from bot crashes or misclicks.
 *   - Otherwise, mark every other active token for this user as consumed
 *     ("invalidated") and issue a fresh one.
 */
export async function issueLoginToken(userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date();

    const [mostRecent] = await tx
      .select()
      .from(authLoginTokens)
      .where(
        and(
          eq(authLoginTokens.userId, userId),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(authLoginTokens.createdAt))
      .limit(1);

    if (mostRecent && now.getTime() - mostRecent.createdAt.getTime() < REUSE_WINDOW_MS) {
      return mostRecent.token;
    }

    // Invalidate every still-active token for this user before minting a new one.
    await tx
      .update(authLoginTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginTokens.userId, userId),
          isNull(authLoginTokens.consumedAt),
        ),
      );

    const token = randomBytes(32).toString("base64url");
    await tx.insert(authLoginTokens).values({
      token,
      userId,
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    });
    return token;
  });
}

export function loginUrl(token: string): string {
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return `${base}/auth/callback?token=${token}`;
}
