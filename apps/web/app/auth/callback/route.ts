import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const now = new Date();
  const consumed = await db
    .update(authLoginTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authLoginTokens.token, token),
        isNull(authLoginTokens.consumedAt),
        gt(authLoginTokens.expiresAt, now),
      ),
    )
    .returning();

  if (consumed.length === 0) {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
  }

  const row = consumed[0]!;
  const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!u) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
  await setAuthCookies(accessJwt, refreshJwt);

  // Tell the bot so it can edit its own message. Best-effort, non-blocking-ish.
  if (row.telegramChatId !== null && row.telegramMessageId !== null) {
    redis
      .publish(
        REDIS_CHANNELS.LOGIN_TOKEN_CONSUMED,
        JSON.stringify({
          chatId: row.telegramChatId.toString(),
          messageId: row.telegramMessageId,
        }),
      )
      .catch((err) => console.warn("[auth/callback] publish failed", err));
  }

  return NextResponse.redirect(new URL("/", publicOriginServer(req)));
}
