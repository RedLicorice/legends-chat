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
  const botUsername = (process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "") || null;

  const uploadResizeCap = parseInt(settings.upload_resize_cap ?? "2560", 10) || 0;
  const jpegQ = parseInt(settings.upload_jpeg_quality ?? "85", 10);
  const uploadJpegQuality = Math.min(1, Math.max(0.01, (Number.isFinite(jpegQ) ? jpegQ : 85) / 100));
  const uploadMaxSizeImageMb = parseInt(settings.upload_max_size_image_mb ?? "10", 10) || 10;
  const uploadAllowOriginal = (settings.upload_allow_original ?? "true") === "true";

  return NextResponse.json({
    invitesRequired,
    registrationMode,
    botUsername,
    uploadResizeCap,
    uploadJpegQuality,
    uploadMaxSizeImageMb,
    uploadAllowOriginal,
  });
}
