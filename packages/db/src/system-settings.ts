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
  | "sidebar_compact_default"
  | "p2p_max_participants"
  | "stun_servers"
  | "turn_url"
  | "turn_username"
  | "turn_credential"
  // upload pipeline
  | "upload_resize_cap"
  | "upload_jpeg_quality"
  | "upload_max_size_image_mb"
  | "upload_max_size_file_mb"
  | "upload_allow_original"
  | "upload_original_per_hour"
  | "upload_original_per_day"
  | "banner_in_topics"
  | "banner_topic_height"
  | "banner_topic_overlap"
  | "banner_overlay_enabled"
  | "banner_overlay_opacity"
  | "banner_fade_enabled"
  | "require_passkey_at_registration" // "true" | "false"
  | "magic_link_login_disabled" // "true" | "false"
  | "e2ee_admin_disclosure" // "true" | "false" — show "admins can read" on E2EE topics
  // link processing
  | "shlink_enabled"
  | "shlink_host"
  | "shlink_api_key"
  | "shlink_default_domain"
  | "shlink_tag_with_user"
  | "shlink_wrap_regex"
  | "strip_tracking_params"
  | "external_link_interstitial_enabled"
  | "external_link_whitelist";

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
