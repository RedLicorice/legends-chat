import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { ACCESS_COOKIE, REFRESH_COOKIE, createLogger } from "@legends/shared";
import { REDIS_CHANNELS } from "@legends/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { issueSession } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 86_400);
const log = createLogger("auth:callback");

export async function GET(req: NextRequest) {
  const publicOrigin = publicOriginServer(req);
  const reqHost = req.headers.get("host");
  const publicHost = (() => { try { return new URL(publicOrigin).host; } catch { return null; } })();
  const errorOrigin = publicHost && reqHost && publicHost !== reqHost ? req.nextUrl.origin : publicOrigin;
  const errorRedirect = (code: string) =>
    NextResponse.redirect(new URL(`/login?error=${code}`, errorOrigin));

  const token = req.nextUrl.searchParams.get("token");
  if (!token) return errorRedirect("missing-token");

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
    // Repeat hits (user double-tap, browser back, WebView prefetch) land here
    // because the token was already consumed by the first request. If this
    // browser already holds a session cookie, silently send it to `/` instead
    // of bouncing through /login?error=invalid-token.
    if (req.cookies.get(ACCESS_COOKIE)?.value) {
      return NextResponse.redirect(new URL("/", errorOrigin));
    }
    log.warn("invalid or expired token", { tokenPrefix: token.slice(0, 8) });
    return errorRedirect("invalid-token");
  }

  const row = consumed[0]!;
  if (!row.userId) {
    log.warn("wrong token type (pending registration not finished)", { id: row.id });
    return errorRedirect("wrong-token-type");
  }
  const [u] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!u) {
    log.error("token references missing user", { userId: row.userId });
    return errorRedirect("user-not-found");
  }

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
  log.info("session issued", { userId: u.id, role: u.role });

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
      .catch((err) => log.warn("redis publish failed", err));
  }

  const secure = process.env.NODE_ENV === "production";
  // Defensive: if the request host doesn't match the configured public origin
  // (e.g. user reached us via localhost while APP_PUBLIC_URL points at LAN IP),
  // redirect to the same origin the user is on so the cookies we set here apply.
  const redirectOrigin = errorOrigin;
  const res = NextResponse.redirect(new URL("/", redirectOrigin));
  res.cookies.set(ACCESS_COOKIE, accessJwt, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: ACCESS_TTL });
  res.cookies.set(REFRESH_COOKIE, refreshJwt, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: REFRESH_TTL });
  return res;
}
