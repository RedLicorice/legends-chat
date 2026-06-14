import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  bots,
  dmParticipants,
  principalPermissionOverrides,
} from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

// Discriminated union on `action` so future bulk operations
// (disable, enable_e2ee, rotate_tokens…) can extend cleanly without breaking
// the parse shape. Mirrors apps/web/app/api/admin/topics/bulk/route.ts.
const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    ids: z.array(z.string().uuid()).min(1).max(200),
  }),
]);

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { ids } = parsed.data;

  try {
    // Short-circuit before opening a transaction when nothing matches.
    const rows = await db
      .select({ id: bots.id })
      .from(bots)
      .where(inArray(bots.id, ids));

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, deleted: 0, ids: [] });
    }

    const foundIds = rows.map((r) => r.id);

    const deleted = await db.transaction(async (tx) => {
      // Manual cleanup — these polymorphic tables don't FK to `bots`, so the
      // bots.id ON DELETE CASCADE doesn't reach them:
      //   - principal_permission_overrides (principalType='bot')
      //   - dm_participants (principalType='bot')
      // All other bot-scoped tables (topic_bots, bot_devices,
      // bot_one_time_keys, bot_to_device_queue, bot_crypto_sent_txns) cascade
      // off bots.id directly — see migration 0045_bot_e2ee.sql and the
      // schema.ts `references(() => bots.id, { onDelete: "cascade" })` calls.
      await tx
        .delete(principalPermissionOverrides)
        .where(
          and(
            eq(principalPermissionOverrides.principalType, "bot"),
            inArray(principalPermissionOverrides.principalId, foundIds),
          ),
        );
      await tx
        .delete(dmParticipants)
        .where(
          and(
            eq(dmParticipants.principalType, "bot"),
            inArray(dmParticipants.principalId, foundIds),
          ),
        );
      const out = await tx
        .delete(bots)
        .where(inArray(bots.id, foundIds))
        .returning({ id: bots.id });
      return out;
    });

    return NextResponse.json({
      ok: true,
      deleted: deleted.length,
      ids: deleted.map((r) => r.id),
    });
  } catch {
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
