import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { userMutes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { liftBan } from "@/lib/moderation";

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
    await db.update(userMutes).set({ liftedAt: new Date(), liftedByUserId: user.id }).where(eq(userMutes.id, id));
  } else {
    await liftBan(id, user.id);
  }

  return NextResponse.json({ ok: true });
}
