import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS, REDIS_CHANNELS } from "@legends/shared";
import { symbols, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

const bodySchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[a-zA-Z]\w*$/, "Letters and digits only, no $ prefix"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  linkedUserId: z.string().uuid().nullable().optional(),
});

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await db
    .select({
      id: symbols.id,
      symbol: symbols.symbol,
      name: symbols.name,
      description: symbols.description,
      linkedUserId: symbols.linkedUserId,
      linkedUserDisplayName: users.displayName,
      linkedUserAvatarUrl: users.avatarUrl,
      createdAt: symbols.createdAt,
    })
    .from(symbols)
    .leftJoin(users, eq(symbols.linkedUserId, users.id))
    .orderBy(asc(symbols.symbol));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const [row] = await db
    .insert(symbols)
    .values({
      symbol: body.data.symbol.toLowerCase(),
      name: body.data.name,
      description: body.data.description ?? null,
      linkedUserId: body.data.linkedUserId ?? null,
    })
    .returning();

  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json(row, { status: 201 });
}
