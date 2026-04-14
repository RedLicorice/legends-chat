import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PERMISSIONS, banReasonSchema } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { banUser } from "@/lib/moderation";

const bodySchema = z.object({
  userId: z.string().uuid(),
  reason: banReasonSchema,
  durationSeconds: z.number().int().positive().nullable(),
  sourceFlagId: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.USERS_BAN_DIRECT)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const expiresAt =
    parsed.data.durationSeconds === null ? null : new Date(Date.now() + parsed.data.durationSeconds * 1000);
  await banUser({
    userId: parsed.data.userId,
    bannedByUserId: user.id,
    reason: parsed.data.reason,
    expiresAt,
    sourceFlagId: parsed.data.sourceFlagId ?? null,
  });
  return NextResponse.json({ ok: true });
}
