import { asc, count, desc, ilike, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { bots, topics, topicBots, botDevices } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

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

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(PERMISSIONS.BOTS_MANAGE);
  if (gate instanceof NextResponse) return gate;

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const where = q ? ilike(bots.name, `%${q}%`) : undefined;

  // Lightweight branch for "select all matching": just the ids for the active
  // filter, so the client can bulk-act on rows beyond the current page.
  if (req.nextUrl.searchParams.get("idsOnly")) {
    const idRows = await db.select({ id: bots.id }).from(bots).where(where);
    return NextResponse.json({ ids: idRows.map((r) => r.id) });
  }

  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [botList, totalRows, topicList] = await Promise.all([
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
      .where(where)
      .orderBy(bots.createdAt)
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ n: count() }).from(bots).where(where),
    db
      .select({ id: topics.id, title: topics.title, isE2ee: topics.isE2ee })
      .from(topics)
      .orderBy(asc(topics.sortOrder), asc(topics.title)),
  ]);

  // Topic assignments + devices only for the bots on this page — the detail
  // panel can only target a row the admin can see (i.e. in this page).
  const botIds = botList.map((b) => b.id);
  const [assignments, devicesList] = await Promise.all([
    botIds.length
      ? db.select({ botId: topicBots.botId, topicId: topicBots.topicId }).from(topicBots).where(inArray(topicBots.botId, botIds))
      : Promise.resolve([] as { botId: string; topicId: string }[]),
    botIds.length
      ? db
          .select({
            botId: botDevices.botId,
            deviceId: botDevices.deviceId,
            identityKeys: botDevices.identityKeys,
            updatedAt: botDevices.updatedAt,
          })
          .from(botDevices)
          .where(inArray(botDevices.botId, botIds))
          .orderBy(desc(botDevices.updatedAt))
      : Promise.resolve([] as { botId: string; deviceId: string; identityKeys: unknown; updatedAt: Date }[]),
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

  return NextResponse.json({
    bots: enriched,
    topics: topicList,
    assignments,
    total: totalRows[0]?.n ?? 0,
  });
}
