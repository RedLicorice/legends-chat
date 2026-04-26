import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { PERMISSIONS } from "@legends/shared";
import { inviteQuotaConfig, registrationConfig } from "@legends/db/schema";
import { getSetting, setSetting } from "@legends/db/system-settings";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [regCfg, quotas, codePrefix] = await Promise.all([
    db.select().from(registrationConfig).where(eq(registrationConfig.id, 1)).limit(1),
    db.select().from(inviteQuotaConfig),
    getSetting(db, "invite_code_prefix"),
  ]);

  return NextResponse.json({
    invitesEnabled: regCfg[0]?.invitesEnabled ?? true,
    quotas: Object.fromEntries(quotas.map((q) => [q.role, q.dailyLimit])),
    codePrefix: codePrefix ?? "LGND",
  });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json() as {
    invitesEnabled?: boolean;
    quotas?: { user?: number; moderator?: number; admin?: number };
    codePrefix?: string;
  };

  if (typeof body.invitesEnabled === "boolean") {
    await db
      .insert(registrationConfig)
      .values({ id: 1, invitesEnabled: body.invitesEnabled, publicRegistrationEnabled: false })
      .onConflictDoUpdate({ target: registrationConfig.id, set: { invitesEnabled: body.invitesEnabled, updatedAt: new Date() } });
  }

  if (body.quotas) {
    for (const [role, limit] of Object.entries(body.quotas) as [string, number][]) {
      if (!["user", "moderator", "admin"].includes(role)) continue;
      if (typeof limit !== "number" || limit < 0) continue;
      await db
        .insert(inviteQuotaConfig)
        .values({ role: role as "user" | "moderator" | "admin", dailyLimit: Math.floor(limit) })
        .onConflictDoUpdate({ target: inviteQuotaConfig.role, set: { dailyLimit: Math.floor(limit) } });
    }
  }

  if (typeof body.codePrefix === "string") {
    const cleaned = body.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "LGND";
    await setSetting(db, "invite_code_prefix", cleaned);
  }

  return NextResponse.json({ ok: true });
}
