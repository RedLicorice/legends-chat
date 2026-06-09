import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { users } from "@legends/db/schema";
import { ACCESS_COOKIE } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Decode-only — token was already verified by getCurrentUser; we just need
// the exp claim so the client can schedule its refresh timer.
function readAccessTokenExp(jwt: string | undefined): number | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [row] = await db
    .select({ bannerUrl: users.bannerUrl, email: users.email })
    .from(users)
    .where(eq(users.id, me.id))
    .limit(1);
  const jar = await cookies();
  const exp = readAccessTokenExp(jar.get(ACCESS_COOKIE)?.value);
  const tokenExpiresAt = exp !== null ? new Date(exp * 1000).toISOString() : null;
  return NextResponse.json({
    id: me.id,
    role: me.role,
    permissions: [...me.permissions],
    displayName: me.displayName,
    avatarUrl: me.avatarUrl,
    bannerUrl: row?.bannerUrl ?? null,
    email: row?.email ?? null,
    isAnon: me.isAnon,
    presenceOptOut: me.presenceOptOut,
    tokenExpiresAt,
  });
}
