import { NextResponse } from "next/server";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { listPendingFlags } from "@/lib/moderation-queue";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.MODERATION_QUEUE_REVIEW)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const flags = await listPendingFlags();
  return NextResponse.json({
    flags: flags.map((f) => ({
      ...f,
      createdAt: f.createdAt.toISOString(),
      message: { ...f.message, deletedAt: f.message.deletedAt?.toISOString() ?? null },
    })),
    canBan: user.permissions.has(PERMISSIONS.USERS_BAN_DIRECT),
    canMute: user.permissions.has(PERMISSIONS.USERS_MUTE_DIRECT),
  });
}
