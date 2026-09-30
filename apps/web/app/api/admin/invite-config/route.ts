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
    publicRegistrationEnabled: regCfg[0]?.publicRegistrationEnabled ?? false,
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
    publicRegistrationEnabled?: boolean;
    quotas?: { user?: number | null; moderator?: number | null; admin?: number | null };
    codePrefix?: string;
  };

  // `publicRegistrationEnabled` had no admin API at all — it could only ever
  // be its schema default (false) — while the toggle that actually opened
  // signup was `invitesEnabled`. Both are settable here now, and both are
  // enforced by /api/auth/register and the Telegram bot, so what the console
  // shows is what the server does.
  if (typeof body.invitesEnabled === "boolean" || typeof body.publicRegistrationEnabled === "boolean") {
    const set: { invitesEnabled?: boolean; publicRegistrationEnabled?: boolean; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (typeof body.invitesEnabled === "boolean") set.invitesEnabled = body.invitesEnabled;
    if (typeof body.publicRegistrationEnabled === "boolean") {
      set.publicRegistrationEnabled = body.publicRegistrationEnabled;
    }
    await db
      .insert(registrationConfig)
      .values({
        id: 1,
        invitesEnabled: body.invitesEnabled ?? true,
        publicRegistrationEnabled: body.publicRegistrationEnabled ?? false,
      })
      .onConflictDoUpdate({ target: registrationConfig.id, set });
  }

  if (body.quotas) {
    for (const [role, limit] of Object.entries(body.quotas) as [string, number | null][]) {
      if (!["user", "moderator", "admin"].includes(role)) continue;
      if (limit !== null && (typeof limit !== "number" || limit < 0)) continue;
      const dailyLimit = limit === null ? null : Math.floor(limit);
      await db
        .insert(inviteQuotaConfig)
        .values({ role, dailyLimit })
        .onConflictDoUpdate({ target: inviteQuotaConfig.role, set: { dailyLimit } });
    }
  }

  if (typeof body.codePrefix === "string") {
    const cleaned = body.codePrefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "LGND";
    await setSetting(db, "invite_code_prefix", cleaned);
  }

  return NextResponse.json({ ok: true });
}
