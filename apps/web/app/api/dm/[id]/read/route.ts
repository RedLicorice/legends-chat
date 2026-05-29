import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant } from "@/lib/dm";

const schema = z.object({ lastReadMessageId: z.string().regex(/^\d+$/) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  await db
    .update(dmParticipants)
    .set({ lastReadMessageId: BigInt(parsed.data.lastReadMessageId) })
    .where(and(eq(dmParticipants.conversationId, id), eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, user.id)));
  return NextResponse.json({ ok: true });
}
