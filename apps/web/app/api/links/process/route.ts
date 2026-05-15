import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAllSettings } from "@legends/db/system-settings";
import { processMessageLinks, type LinkProcessorSettings } from "@/lib/link-processor";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { text?: unknown };
  try {
    body = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return NextResponse.json({ text });

  try {
    const settings = await getAllSettings(db);
    const cfg: LinkProcessorSettings = {
      shlinkEnabled: settings.shlink_enabled === "true",
      shlinkHost: settings.shlink_host?.trim() || null,
      shlinkApiKey: settings.shlink_api_key?.trim() || null,
      shlinkDefaultDomain: settings.shlink_default_domain?.trim() || null,
      shlinkTagWithUser: settings.shlink_tag_with_user === "true",
      shlinkWrapRegex: settings.shlink_wrap_regex?.trim() || null,
      stripTracking: settings.strip_tracking_params === "true",
      publicOrigin: process.env.APP_PUBLIC_URL ?? null,
    };
    const processed = await processMessageLinks(text, cfg, user.id);
    return NextResponse.json({ text: processed });
  } catch (err) {
    console.error("[links/process] failed", err);
    // Never break the send flow — return the original text.
    return NextResponse.json({ text });
  }
}
