import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { authLoginTokens, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { issueSession, setAuthCookies } from "@/lib/auth";

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
    .returning({ userId: authLoginTokens.userId });

  if (consumed.length === 0) {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
  }

  const userId = consumed[0]!.userId;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const { accessJwt, refreshJwt } = await issueSession(u.id, u.role);
  await setAuthCookies(accessJwt, refreshJwt);

  return NextResponse.redirect(new URL("/", req.url));
}
