import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAllSettings, setSetting } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { asc } from "drizzle-orm";
import { AUDIT_ACTIONS, logAdminAction } from "@/lib/audit-log";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [settings, topicList] = await Promise.all([
    getAllSettings(db),
    db.select({ id: topics.id, title: topics.title, slug: topics.slug }).from(topics).orderBy(asc(topics.sortOrder)),
  ]);

  return NextResponse.json({ settings, topics: topicList });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json() as Record<string, string | null>;
  const allowed = [
    "default_topic_id",
    "welcome_message",
    "farewell_message",
    "community_name",
    "community_logo_url",
    "community_banner_url",
    "pwa_icon_url",
    "registration_mode",
    "giphy_enabled",
    "giphy_api_key",
    "sidebar_compact_default",
    "p2p_max_participants",
    "stun_servers",
    "turn_url",
    "turn_username",
    "turn_credential",
    "banner_in_topics",
    "banner_topic_height",
    "banner_topic_overlap",
    "banner_overlay_enabled",
    "banner_overlay_opacity",
    "banner_fade_enabled",
    "require_passkey_at_registration",
    "magic_link_login_disabled",
    "e2ee_admin_disclosure",
    "upload_resize_cap",
    "upload_jpeg_quality",
    "upload_max_size_image_mb",
    "upload_max_size_file_mb",
    "upload_allow_original",
    "upload_original_per_hour",
    "upload_original_per_day",
    "upload_per_hour",
    "upload_per_day",
    "upload_bytes_per_day_mb",
    "upload_quota_mb",
    "upload_orphan_grace_hours",
    "shlink_enabled",
    "shlink_host",
    "shlink_api_key",
    "shlink_default_domain",
    "shlink_tag_with_user",
    "shlink_wrap_regex",
    "strip_tracking_params",
    "external_link_interstitial_enabled",
    "external_link_whitelist",
  ] as const;

  // cr-m10: ~30 allowlisted keys (including e2ee_admin_disclosure,
  // registration_mode, turn_credential and upload_allow_original) used to be
  // rewritable with no record of who changed what. Capture before/after for
  // every key actually touched.
  const before = await getAllSettings(db);
  const changed: Record<string, { from: string | null; to: string | null }> = {};
  const SECRET_KEYS = new Set(["turn_credential", "giphy_api_key", "shlink_api_key"]);

  for (const key of allowed) {
    if (key in body) {
      const val = body[key];
      const prev = before[key] ?? null;
      const next = val ?? null;
      if (prev !== next) {
        // Never copy a secret's value into the audit row; record that it moved.
        changed[key] = SECRET_KEYS.has(key)
          ? { from: prev === null ? null : "<redacted>", to: next === null ? null : "<redacted>" }
          : { from: prev, to: next };
      }
      await setSetting(db, key, next);
    }
  }

  if (Object.keys(changed).length > 0) {
    await logAdminAction({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.SETTINGS_UPDATE,
      targetType: "system_settings",
      targetId: null,
      metadata: { changed },
    });
  }

  revalidatePath("/", "layout");

  return NextResponse.json({ ok: true });
}
