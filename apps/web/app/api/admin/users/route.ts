import { ilike, or } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const actor = await getCurrentUser();
  if (!actor || !actor.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";

  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: users.role,
      isAnon: users.isAnon,
      telegramUsername: users.telegramUsername,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      q
        ? or(
            ilike(users.displayName, `%${q}%`),
            ilike(users.telegramUsername, `%${q}%`),
          )
        : undefined,
    )
    .orderBy(users.displayName)
    .limit(100);

  return NextResponse.json(rows);
}
