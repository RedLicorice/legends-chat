import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { authLoginTokens, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { publicOriginServer } from "@/lib/public-origin.server";

// Mirrors apps/bot/src/login.ts:issueLoginToken — short reuse window so
// a double-click on "Generate link" returns the same token instead of
// minting two, and any other still-active token for this user is consumed
// before a new one is issued.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const REUSE_WINDOW_MS = 15 * 1000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { token, expiresAt } = await db.transaction(async (tx) => {
    // Serialize concurrent token issuance for the same user — without this
    // lock, two concurrent POSTs both read mostRecent before either UPDATE
    // lands, both pass the reuse-window check, and both INSERT a fresh
    // token, leaving two simultaneously-valid links.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`login-token:${id}`}))`);
    const now = new Date();

    const [mostRecent] = await tx
      .select()
      .from(authLoginTokens)
      .where(
        and(
          eq(authLoginTokens.userId, id),
          isNull(authLoginTokens.consumedAt),
          gt(authLoginTokens.expiresAt, now),
        ),
      )
      .orderBy(desc(authLoginTokens.createdAt))
      .limit(1);

    if (
      mostRecent &&
      now.getTime() - mostRecent.createdAt.getTime() < REUSE_WINDOW_MS
    ) {
      return { token: mostRecent.token, expiresAt: mostRecent.expiresAt };
    }

    await tx
      .update(authLoginTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authLoginTokens.userId, id),
          isNull(authLoginTokens.consumedAt),
        ),
      );

    const newToken = randomBytes(32).toString("base64url");
    const newExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    await tx
      .insert(authLoginTokens)
      .values({ token: newToken, userId: id, expiresAt: newExpiresAt });
    return { token: newToken, expiresAt: newExpiresAt };
  });

  const origin = publicOriginServer(req);
  const url = `${origin}/auth/callback?token=${token}`;

  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    url,
  });
}
