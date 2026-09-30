import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { userMutes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { liftBan } from "@/lib/moderation";
import { AUDIT_ACTIONS, logAdminAction } from "@/lib/audit-log";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.USERS_BAN_LIFT)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "ban";
  const { id } = await params;

  if (type === "mute") {
    const [row] = await db
      .update(userMutes)
      .set({ liftedAt: new Date(), liftedByUserId: user.id })
      .where(eq(userMutes.id, id))
      .returning({ userId: userMutes.userId });
    // cr-m10: liftBan audits itself; the mute-lift path writes here.
    await logAdminAction({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.USER_MUTE_LIFT,
      targetType: "user",
      targetId: row?.userId ?? null,
      metadata: { muteId: id },
    });
  } else {
    await liftBan(id, user.id);
  }

  return NextResponse.json({ ok: true });
}
