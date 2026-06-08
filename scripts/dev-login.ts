#!/usr/bin/env -S tsx
/**
 * Dev CLI: mint a login token + print the URL the bot would send.
 *
 * Usage:
 *   pnpm dev:login                       # picks an admin user (deterministic)
 *   pnpm dev:login <userId|displayName>  # specific user
 *
 * The token uses the same DB write the Telegram bot's issueLoginToken does
 * (re-use window + active-token invalidation). Output is a fully-formed URL
 * pointing at APP_PUBLIC_URL (falls back to http://localhost:3000) — paste
 * into any browser to land on /auth/landing the same way a bot link would.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, ilike, isNull, sql } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { db } from "@legends/db";

const TOKEN_TTL_MS = 5 * 60 * 1000;
const REUSE_WINDOW_MS = 15 * 1000;

async function resolveUserId(input: string | undefined): Promise<{ id: string; displayName: string; role: string }> {
  if (input) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input);
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users)
      .where(isUuid ? eq(users.id, input) : ilike(users.displayName, input))
      .limit(1);
    const u = rows[0];
    if (!u) throw new Error(`no user matching '${input}'`);
    return u;
  }
  // No arg: first admin by created_at.
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, role: users.role })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(sql`created_at ASC`)
    .limit(1);
  const u = rows[0];
  if (!u) throw new Error("no admin user in DB");
  return u;
}

async function issueLoginToken(userId: string): Promise<{ token: string; expiresAt: Date; reused: boolean }> {
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
      return { token: mostRecent.token, expiresAt: mostRecent.expiresAt, reused: true };
    }

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
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    await tx.insert(authLoginTokens).values({ token, userId, expiresAt });
    return { token, expiresAt, reused: false };
  });
}

async function main() {
  const arg = process.argv[2];
  const user = await resolveUserId(arg);
  const { token, expiresAt, reused } = await issueLoginToken(user.id);
  const origin = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  const landingUrl = `${origin}/auth/landing?token=${encodeURIComponent(token)}`;
  const callbackUrl = `${origin}/auth/callback?token=${encodeURIComponent(token)}`;

  process.stdout.write(
    [
      `user:        ${user.displayName} (${user.role}) — ${user.id}`,
      `token:       ${token}`,
      `expires:     ${expiresAt.toISOString()} (${reused ? "REUSED" : "fresh"})`,
      ``,
      `landing URL: ${landingUrl}`,
      `direct URL:  ${callbackUrl}`,
      ``,
    ].join("\n"),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
