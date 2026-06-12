import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bots,
  botDevices,
  botOneTimeKeys,
  botToDeviceQueue,
  botCryptoSentTxns,
} from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const BodySchema = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ rotate: z.literal(true) }).strict(),
]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;

  const [row] = await db
    .select({ id: bots.id, e2eeState: bots.e2eeState, e2eeDeviceId: bots.e2eeDeviceId })
    .from(bots)
    .where(eq(bots.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if ("rotate" in parsed.data) {
    await db.transaction(async (tx) => {
      await tx.delete(botDevices).where(eq(botDevices.botId, id));
      await tx.delete(botOneTimeKeys).where(eq(botOneTimeKeys.botId, id));
      await tx.delete(botToDeviceQueue).where(eq(botToDeviceQueue.botId, id));
      await tx.delete(botCryptoSentTxns).where(eq(botCryptoSentTxns.botId, id));
      await tx
        .update(bots)
        .set({ e2eeState: "pending", e2eeDeviceId: null })
        .where(eq(bots.id, id))
        .returning();
    });
    return NextResponse.json({ id, e2ee_state: "pending", e2ee_device_id: null });
  }

  const enabled = parsed.data.enabled;
  if (enabled) {
    if (row.e2eeState === "disabled") {
      await db
        .update(bots)
        .set({ e2eeState: "pending" })
        .where(eq(bots.id, id))
        .returning();
      return NextResponse.json({ id, e2ee_state: "pending", e2ee_device_id: row.e2eeDeviceId });
    }
    // pending or ready: no-op
    return NextResponse.json({ id, e2ee_state: row.e2eeState, e2ee_device_id: row.e2eeDeviceId });
  }

  // enabled === false: only flip state; keep device row + device_id intact
  if (row.e2eeState !== "disabled") {
    await db
      .update(bots)
      .set({ e2eeState: "disabled" })
      .where(eq(bots.id, id))
      .returning();
  }
  return NextResponse.json({ id, e2ee_state: "disabled", e2ee_device_id: row.e2eeDeviceId });
}
