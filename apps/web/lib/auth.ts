import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessTokenPayloadSchema,
  refreshTokenPayloadSchema,
  REDIS_KEYS,
  type AccessTokenPayload,
  type Role,
} from "@legends/shared";
import { sessions, userBans, userMutes, users, rolesPermissions } from "@legends/db/schema";
import { db } from "./db";
import { redis } from "./redis";

const accessSecret = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET ?? (() => { throw new Error("JWT_ACCESS_SECRET not set"); })(),
);
const refreshSecret = new TextEncoder().encode(
  process.env.JWT_REFRESH_SECRET ?? (() => { throw new Error("JWT_REFRESH_SECRET not set"); })(),
);

const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
// 24h: the window during which the app silently refreshes before asking
// the user to re-authenticate via the Telegram bot.
const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 86_400);

export async function issueSession(userId: string, role: Role): Promise<{ accessJwt: string; refreshJwt: string }> {
  const jti = randomUUID();
  const sid = randomUUID();
  const refreshJti = randomUUID();

  const [accessJwt, refreshJwt] = await Promise.all([
    new SignJWT({ sub: userId, role, jti })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL}s`)
      .sign(accessSecret),
    new SignJWT({ sub: userId, jti: refreshJti, sid })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${REFRESH_TTL}s`)
      .sign(refreshSecret),
  ]);

  await db.insert(sessions).values({
    id: sid,
    userId,
    refreshTokenHash: refreshJti,
  });

  return { accessJwt, refreshJwt };
}

export async function setAuthCookies(accessJwt: string, refreshJwt: string): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";
  jar.set(ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TTL,
  });
  jar.set(REFRESH_COOKIE, refreshJwt, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_TTL,
  });
}

export async function clearAuthCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/**
 * Reads the refresh cookie, verifies it, checks the matching `sessions`
 * row is still active, and mints a new access JWT that it writes back to
 * the cookie jar. Returns true on success, false on any failure (caller
 * should treat the user as unauthenticated).
 *
 * The refresh JWT itself is not rotated — its expiry is the hard 24h
 * limit after which the user must go through the bot again.
 */
export async function refreshAccessCookie(): Promise<boolean> {
  const jar = await cookies();
  const refreshCookie = jar.get(REFRESH_COOKIE)?.value;
  if (!refreshCookie) return false;

  let payload: { sub: string; jti: string; sid: string };
  try {
    const verified = await jwtVerify(refreshCookie, refreshSecret, { algorithms: ["HS256"] });
    payload = refreshTokenPayloadSchema.parse(verified.payload);
  } catch {
    return false;
  }

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, payload.sid))
    .limit(1);
  if (!session) return false;
  if (session.refreshTokenHash !== payload.jti) return false;
  if (session.revokedAt) return false;
  if (session.userId !== payload.sub) return false;

  if (await isUserBanned(payload.sub)) return false;

  const [u] = await db
    .select({ id: users.id, role: users.role, isAnon: users.isAnon, anonExpiresAt: users.anonExpiresAt })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);
  if (!u) return false;

  // Anon users expire 48 h after their last refresh — extend the window each time.
  if (u.isAnon) {
    const newExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.update(users).set({ anonExpiresAt: newExpiry }).where(eq(users.id, u.id));
  }

  const newJti = randomUUID();
  const accessJwt = await new SignJWT({ sub: u.id, role: u.role, jti: newJti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .sign(accessSecret);

  const secure = process.env.NODE_ENV === "production";
  jar.set(ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TTL,
  });
  return true;
}

export interface CurrentUser {
  id: string;
  role: Role;
  permissions: Set<string>;
  displayName: string;
  avatarUrl: string | null;
  isAnon: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const jar = await cookies();
  const tok = jar.get(ACCESS_COOKIE)?.value;
  if (!tok) return null;
  let payload: AccessTokenPayload;
  try {
    const verified = await jwtVerify(tok, accessSecret, { algorithms: ["HS256"] });
    payload = accessTokenPayloadSchema.parse(verified.payload);
  } catch {
    return null;
  }
  const revoked = await redis.get(REDIS_KEYS.REVOKED_JTI(payload.jti));
  if (revoked) return null;
  if (await isUserBanned(payload.sub)) return null;

  const [u] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!u) return null;

  const perms = await db
    .select({ permission: rolesPermissions.permission })
    .from(rolesPermissions)
    .where(eq(rolesPermissions.role, u.role));

  return {
    id: u.id,
    role: u.role,
    permissions: new Set(perms.map((p) => p.permission)),
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    isAnon: u.isAnon,
  };
}

export async function isUserBanned(userId: string): Promise<boolean> {
  const cached = await redis.get(REDIS_KEYS.BAN_CACHE(userId));
  if (cached === "1") return true;
  if (cached === "0") return false;
  const now = new Date();
  const rows = await db
    .select({ id: userBans.id })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, userId),
        isNull(userBans.liftedAt),
        or(isNull(userBans.expiresAt), gt(userBans.expiresAt, now)),
      ),
    )
    .limit(1);
  const banned = rows.length > 0;
  await redis.set(REDIS_KEYS.BAN_CACHE(userId), banned ? "1" : "0", "EX", 60);
  return banned;
}

export async function getUserMute(userId: string): Promise<{ reason: string; expiresAt: Date | null } | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(userMutes)
    .where(
      and(
        eq(userMutes.userId, userId),
        isNull(userMutes.liftedAt),
        or(isNull(userMutes.expiresAt), gt(userMutes.expiresAt, now)),
      ),
    )
    .orderBy(desc(userMutes.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { reason: row.reason, expiresAt: row.expiresAt };
}
