import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { userBans, userMutes } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

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
  const now = new Date();

  if (type === "mute") {
    await db.update(userMutes).set({ liftedAt: now, liftedByUserId: user.id }).where(eq(userMutes.id, id));
  } else {
    await db.update(userBans).set({ liftedAt: now, liftedByUserId: user.id }).where(eq(userBans.id, id));
  }

  return NextResponse.json({ ok: true });
}
