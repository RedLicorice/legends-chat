import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@legends/shared";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 86_400);

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
  if (!row.userId) {
    return NextResponse.json({ error: "wrong token type" }, { status: 400 });
  }
  const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!u) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);

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

  const secure = process.env.NODE_ENV === "production";
  const res = NextResponse.redirect(new URL("/", publicOriginServer(req)));
  res.cookies.set(ACCESS_COOKIE, accessJwt, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: ACCESS_TTL });
  res.cookies.set(REFRESH_COOKIE, refreshJwt, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: REFRESH_TTL });
  return res;
}
