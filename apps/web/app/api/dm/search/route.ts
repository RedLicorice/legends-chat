import { NextResponse } from "next/server";
import { and, eq, ilike, ne } from "drizzle-orm";
import { users, bots } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const minuteKey = `dm:search:${user.id}:m:${Math.floor(Date.now() / 60000)}`;
  const rl = await checkAndIncrement(minuteKey, 30, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json({ error: "rate limit exceeded", retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);
  if (q.length > 64) return NextResponse.json([]);

  const [userRows, botRows] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(and(ilike(users.displayName, `%${q}%`), ne(users.id, user.id), eq(users.isAnon, false)))
      .limit(6),
    db
      .select({ id: bots.id, displayName: bots.name, avatarUrl: bots.avatarUrl })
      .from(bots)
      .where(and(ilike(bots.name, `%${q}%`), eq(bots.dmEnabled, true), eq(bots.isActive, true)))
      .limit(4),
  ]);
  const out = [
    ...userRows.map((u) => ({ type: "user" as const, ...u })),
    ...botRows.map((b) => ({ type: "bot" as const, ...b })),
  ];
  return NextResponse.json(out);
}
