import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { inviteCodes } from "@legends/db/schema";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("code");

  if (!raw || !raw.trim()) {
    return NextResponse.json({ valid: false, error: "No code provided." });
  }

  const code = raw.trim().toUpperCase();
  const now = new Date();

  const [invite] = await db
    .select()
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.code, code),
        or(isNull(inviteCodes.expiresAt), gt(inviteCodes.expiresAt, now)),
        or(isNull(inviteCodes.maxUses), sql`${inviteCodes.usesCount} < ${inviteCodes.maxUses}`),
      ),
    )
    .limit(1);

  if (!invite) {
    return NextResponse.json({ valid: false, error: "Invalid or expired invite code." });
  }

  return NextResponse.json({ valid: true });
}
