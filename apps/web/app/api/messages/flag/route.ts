import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { messageFlags } from "@legends/db/schema";
import { PERMISSIONS, flagReasonSchema } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser, getUserMute } from "@/lib/auth";

const bodySchema = z.object({
  messageId: z.string().regex(/^\d+$/),
  reason: flagReasonSchema,
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.MESSAGES_FLAG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await getUserMute(user.id)) {
    return NextResponse.json({ error: "muted" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await db.insert(messageFlags).values({
    messageId: BigInt(parsed.data.messageId),
    reporterUserId: user.id,
    reason: parsed.data.reason,
  });
  return NextResponse.json({ ok: true });
}
