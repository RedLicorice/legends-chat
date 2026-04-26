import { eq } from "drizzle-orm";
import { db as defaultDb, type DB } from "./client";
import { systemSettings } from "./schema";

export type SystemSettingKey =
  | "default_topic_id"
  | "welcome_message"
  | "farewell_message"
  | "community_name"
  | "community_logo_url"
  | "community_banner_url"
  | "pwa_icon_url"
  | "registration_mode" // "telegram_only" | "open" | "closed"
  | "giphy_enabled"
  | "giphy_api_key"
  | "invite_code_prefix"
  | "default_theme"
  | "theme_accent_color"
  | "sidebar_compact_default";

export async function getSetting(
  dbInstance: DB,
  key: SystemSettingKey,
): Promise<string | null> {
  const rows = await dbInstance.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(
  dbInstance: DB,
  key: SystemSettingKey,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await dbInstance.delete(systemSettings).where(eq(systemSettings.key, key));
    return;
  }
  await dbInstance
    .insert(systemSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

export async function getAllSettings(dbInstance: DB = defaultDb): Promise<Record<string, string>> {
  const rows = await dbInstance.select().from(systemSettings);
  return Object.fromEntries(rows.filter((r) => r.value !== null).map((r) => [r.key, r.value!]));
}
