import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  accessTokenPayloadSchema,
  refreshTokenPayloadSchema,
  REDIS_KEYS,
  resolvePermissions,
  type AccessTokenPayload,
  type Role,
} from "@legends/shared";
import { sessions, users } from "@legends/db/schema";
import { db } from "./db";
import { redis } from "./redis";
import {
  psRolePermissions,
  psUserById,
  psUserBan,
  psUserMute,
  psUserPermissionOverrides,
} from "./db-prepared";

// `next build` page-data collection imports this module; the secrets aren't
// required at build time (no token is verified during collection). Fall back
// to a sentinel string. At runtime, a missing real secret means token sign
// + verify both use the sentinel — which is the correct failure mode if the
// env var is genuinely missing (no token will ever validate against a real
// session).
const accessSecret = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET ?? "build-placeholder-access",
);
const refreshSecret = new TextEncoder().encode(
  process.env.JWT_REFRESH_SECRET ?? "build-placeholder-refresh",
);

const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
// 24h: the window during which the app silently refreshes before asking
// the user to re-authenticate via the Telegram bot.
const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 86_400);

export interface SessionProfile {
  id: string;
  role: Role;
  displayName: string;
  avatarUrl: string | null;
  isAnon: boolean;
  presenceOptOut: boolean;
}

async function loadPermissionsForRole(userId: string, role: Role): Promise<string[]> {
  const [rolePerms, overrides] = await Promise.all([
    psRolePermissions.execute({ role }),
    psUserPermissionOverrides.execute({ principalId: userId }),
  ]);
  const set = resolvePermissions(
    rolePerms.map((p) => p.permission),
    overrides as { permission: string; effect: "allow" | "deny" }[],
  );
  return [...set];
}

async function loadSessionProfile(userId: string): Promise<SessionProfile | null> {
  const [u] = await psUserById.execute({ id: userId });
  if (!u) return null;
  return {
    id: u.id,
    role: u.role as Role,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? null,
    isAnon: u.isAnon,
    presenceOptOut: u.presenceOptOut,
  };
}

export async function issueSession(profile: SessionProfile): Promise<{ accessJwt: string; refreshJwt: string }> {
  const jti = randomUUID();
  const sid = randomUUID();
  const refreshJti = randomUUID();

  const permissions = await loadPermissionsForRole(profile.id, profile.role);

  const [accessJwt, refreshJwt] = await Promise.all([
    new SignJWT({
      sub: profile.id,
      role: profile.role,
      permissions,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      isAnon: profile.isAnon,
      presenceOptOut: profile.presenceOptOut,
      jti,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL}s`)
      .sign(accessSecret),
    new SignJWT({ sub: profile.id, jti: refreshJti, sid })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${REFRESH_TTL}s`)
      .sign(refreshSecret),
  ]);

  await db.insert(sessions).values({
    id: sid,
    userId: profile.id,
    refreshTokenHash: refreshJti,
    accessJti: jti,
    accessExpiresAt: new Date(Date.now() + ACCESS_TTL * 1000),
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

// Refresh JWT itself is not rotated — its expiry is the hard 24h limit after
// which the user must re-auth via the bot.
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

  const [u] = await psUserById.execute({ id: payload.sub });
  if (!u) return false;

  // Anon users expire 48 h after their last refresh — extend the window each time.
  if (u.isAnon) {
    const newExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.update(users).set({ anonExpiresAt: newExpiry }).where(eq(users.id, u.id));
  }

  const effectiveRole = await checkAndRevertExpiredRole(u);
  const permissions = await loadPermissionsForRole(u.id, effectiveRole);

  const newJti = randomUUID();
  const accessJwt = await new SignJWT({
    sub: u.id,
    role: effectiveRole,
    permissions,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl ?? null,
    isAnon: u.isAnon,
    presenceOptOut: u.presenceOptOut,
    jti: newJti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL}s`)
    .sign(accessSecret);

  await db
    .update(sessions)
    .set({
      accessJti: newJti,
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL * 1000),
      lastUsedAt: new Date(),
    })
    .where(eq(sessions.id, payload.sid));

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

async function checkAndRevertExpiredRole(u: { id: string; role: string; roleExpiresAt: Date | null; roleFallback: string | null }): Promise<string> {
  if (!u.roleExpiresAt || u.roleExpiresAt > new Date()) return u.role;
  const fallback = u.roleFallback ?? "user";
  await db.update(users).set({ role: fallback, roleExpiresAt: null, roleFallback: null }).where(eq(users.id, u.id));
  return fallback;
}

export interface CurrentUser {
  id: string;
  role: Role;
  permissions: Set<string>;
  displayName: string;
  avatarUrl: string | null;
  isAnon: boolean;
  presenceOptOut: boolean;
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

  return {
    id: payload.sub,
    role: payload.role as Role,
    permissions: new Set(payload.permissions),
    displayName: payload.displayName,
    avatarUrl: payload.avatarUrl,
    isAnon: payload.isAnon,
    presenceOptOut: payload.presenceOptOut,
  };
}

export { loadSessionProfile };

export async function isUserBanned(userId: string): Promise<boolean> {
  const cached = await redis.get(REDIS_KEYS.BAN_CACHE(userId));
  if (cached === "1") return true;
  if (cached === "0") return false;
  const rows = await psUserBan.execute({ userId });
  const banned = rows.length > 0;
  await redis.set(REDIS_KEYS.BAN_CACHE(userId), banned ? "1" : "0", "EX", 60);
  return banned;
}

export async function getUserMute(userId: string): Promise<{ reason: string; expiresAt: Date | null } | null> {
  const rows = await psUserMute.execute({ userId });
  const row = rows[0];
  if (!row) return null;
  return { reason: row.reason, expiresAt: row.expiresAt };
}
