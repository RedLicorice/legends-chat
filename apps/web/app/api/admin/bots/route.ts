import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, users } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { generateBotToken, hashBotToken } from "@/lib/bot-auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await db
    .select({
      id: bots.id,
      name: bots.name,
      ownerUserId: bots.ownerUserId,
      ownerName: users.displayName,
      avatarUrl: bots.avatarUrl,
      webhookUrl: bots.webhookUrl,
      isActive: bots.isActive,
      createdAt: bots.createdAt,
    })
    .from(bots)
    .leftJoin(users, eq(bots.ownerUserId, users.id))
    .orderBy(bots.createdAt);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json() as { name: string; avatarUrl?: string };
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  const rawToken = generateBotToken();
  const tokenHash = hashBotToken(rawToken);

  const [bot] = await db
    .insert(bots)
    .values({ name: body.name.trim(), ownerUserId: user.id, tokenHash, avatarUrl: body.avatarUrl ?? null })
    .returning();

  return NextResponse.json({ bot, token: rawToken }, { status: 201 });
}
