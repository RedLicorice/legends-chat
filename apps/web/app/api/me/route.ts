import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({
    id: me.id,
    role: me.role,
    permissions: [...me.permissions],
    displayName: me.displayName,
    avatarUrl: me.avatarUrl,
    bannerUrl: me.bannerUrl,
    email: me.email,
    isAnon: me.isAnon,
    presenceOptOut: me.presenceOptOut,
  });
}
