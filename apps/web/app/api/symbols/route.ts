import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { symbols, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: symbols.id,
      symbol: symbols.symbol,
      name: symbols.name,
      description: symbols.description,
      linkedUserId: symbols.linkedUserId,
      linkedUserDisplayName: users.displayName,
      linkedUserAvatarUrl: users.avatarUrl,
    })
    .from(symbols)
    .leftJoin(users, eq(symbols.linkedUserId, users.id))
    .orderBy(asc(symbols.symbol));

  return NextResponse.json(rows);
}
