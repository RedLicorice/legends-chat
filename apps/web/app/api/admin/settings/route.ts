import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAllSettings, setSetting } from "@legends/db/system-settings";
import { topics } from "@legends/db/schema";
import { asc } from "drizzle-orm";

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
    "upload_resize_cap",
    "upload_jpeg_quality",
    "upload_max_size_image_mb",
    "upload_max_size_file_mb",
    "upload_allow_original",
    "upload_original_per_hour",
    "upload_original_per_day",
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

  for (const key of allowed) {
    if (key in body) {
      const val = body[key];
      await setSetting(db, key, val ?? null);
    }
  }

  revalidatePath("/", "layout");

  return NextResponse.json({ ok: true });
}
