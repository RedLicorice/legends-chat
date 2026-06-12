import { asc, desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, topics, topicBots, botDevices } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

function fingerprintFromIdentityKeys(identityKeys: unknown): string | undefined {
  if (!identityKeys || typeof identityKeys !== "object") return undefined;
  const obj = identityKeys as Record<string, unknown>;
  // Identity keys are stored as `{ "ed25519:<device>": "<hex>" }` (Matrix
  // shape) but historically also as `{ ed25519: "<hex>" }`. Handle both.
  let ed: unknown = obj.ed25519;
  if (typeof ed !== "string") {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("ed25519:") && typeof v === "string") {
        ed = v;
        break;
      }
    }
  }
  if (typeof ed !== "string") return undefined;
  // First 32 hex chars = first 16 bytes; the UI groups them in 4s.
  return ed.slice(0, 32);
}

export async function GET() {
  const gate = await requireAdmin(PERMISSIONS.BOTS_MANAGE);
  if (gate instanceof NextResponse) return gate;

  const [botList, topicList, assignments, devicesList] = await Promise.all([
    db
      .select({
        id: bots.id,
        name: bots.name,
        avatarUrl: bots.avatarUrl,
        description: bots.description,
        webhookUrl: bots.webhookUrl,
        isActive: bots.isActive,
        createdAt: bots.createdAt,
        role: bots.role,
        roleExpiresAt: bots.roleExpiresAt,
        roleFallback: bots.roleFallback,
        e2eeState: bots.e2eeState,
        e2eeDeviceId: bots.e2eeDeviceId,
      })
      .from(bots)
      .orderBy(bots.createdAt),
    db
      .select({ id: topics.id, title: topics.title, isE2ee: topics.isE2ee })
      .from(topics)
      .orderBy(asc(topics.sortOrder), asc(topics.title)),
    db.select({ botId: topicBots.botId, topicId: topicBots.topicId }).from(topicBots),
    db
      .select({
        botId: botDevices.botId,
        deviceId: botDevices.deviceId,
        identityKeys: botDevices.identityKeys,
        updatedAt: botDevices.updatedAt,
      })
      .from(botDevices)
      .orderBy(desc(botDevices.updatedAt)),
  ]);

  // Pick the latest device per bot (devicesList ordered desc by updatedAt).
  const latestDeviceByBot = new Map<string, { identityKeys: unknown; updatedAt: Date }>();
  for (const d of devicesList) {
    if (!latestDeviceByBot.has(d.botId)) {
      latestDeviceByBot.set(d.botId, { identityKeys: d.identityKeys, updatedAt: d.updatedAt });
    }
  }

  const enriched = botList.map((b) => {
    const dev = b.e2eeDeviceId ? latestDeviceByBot.get(b.id) : undefined;
    return {
      ...b,
      e2ee_state: b.e2eeState,
      e2ee_device_id: b.e2eeDeviceId,
      identityKeyFingerprint: dev ? fingerprintFromIdentityKeys(dev.identityKeys) : undefined,
      lastKeysUploadAt: dev ? new Date(dev.updatedAt).toISOString() : undefined,
    };
  });

  return NextResponse.json({ bots: enriched, topics: topicList, assignments });
}
