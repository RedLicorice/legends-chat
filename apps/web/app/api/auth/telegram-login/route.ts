import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession, setAuthCookies } from "@/lib/auth";
import { getSetting } from "@legends/db/system-settings";
import { clientIp, enforceRateLimit } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const limited = await enforceRateLimit(`auth:tg-login:ip:${clientIp(req)}`, 20, 900);
  if (limited) return limited;

  const magicLinkDisabled = (await getSetting(db, "magic_link_login_disabled")) === "true";
  if (magicLinkDisabled) {
    return NextResponse.json({ error: "Magic link login is disabled." }, { status: 403 });
  }

  const body = await req.json() as { token: string };
  const token = body.token?.trim();
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
    // This token is a pending registration, not a login token.
    return NextResponse.json({ error: "wrong token type" }, { status: 400 });
  }

  const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!u) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession({
    id: u.id,
    role: u.role,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? null,
    isAnon: u.isAnon,
    presenceOptOut: u.presenceOptOut,
  });
  await setAuthCookies(accessJwt, refreshJwt);

  // Mirror behaviour of /auth/callback — notify bot so it can edit its message.
  if (row.telegramChatId !== null && row.telegramMessageId !== null) {
    redis.publish(REDIS_CHANNELS.LOGIN_TOKEN_CONSUMED, JSON.stringify({
      chatId: row.telegramChatId.toString(),
      messageId: row.telegramMessageId,
    })).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
