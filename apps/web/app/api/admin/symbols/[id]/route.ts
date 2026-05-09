import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS, REDIS_CHANNELS } from "@legends/shared";
import { symbols } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

const bodySchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[a-zA-Z]\w*$/).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  linkedUserId: z.string().uuid().nullable().optional(),
});

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return null;
  return user;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const updates: Partial<typeof symbols.$inferInsert> = {};
  if (body.data.symbol !== undefined) updates.symbol = body.data.symbol.toLowerCase();
  if (body.data.name !== undefined) updates.name = body.data.name;
  if ("description" in body.data) updates.description = body.data.description ?? null;
  if ("linkedUserId" in body.data) updates.linkedUserId = body.data.linkedUserId ?? null;

  const [row] = await db
    .update(symbols)
    .set(updates)
    .where(eq(symbols.id, numId))
    .returning();

  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json(row);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  await db.delete(symbols).where(eq(symbols.id, numId));
  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json({ ok: true });
}
