import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { registrationConfig } from "@legends/db/schema";
import { getAllSettings } from "@legends/db/system-settings";
import { db } from "@/lib/db";

export async function GET() {
  const [regCfg, settings] = await Promise.all([
    db.select().from(registrationConfig).where(eq(registrationConfig.id, 1)).limit(1),
    getAllSettings(db),
  ]);

  const invitesRequired = regCfg[0]?.invitesEnabled ?? false;
  const registrationMode = settings.registration_mode ?? "telegram_only";

  return NextResponse.json({ invitesRequired, registrationMode });
}
