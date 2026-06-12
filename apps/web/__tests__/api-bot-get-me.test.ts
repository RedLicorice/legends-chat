// GET /api/bot/v1/getMe — must expose the bot's E2EE state machine fields
// (`e2ee_state`, `e2ee_device_id`) alongside the basic identity surface. The
// bot SDK reads these on startup to decide whether to publish device keys
// (Task 21 / R3). When omitted, the SDK can't tell that the bot was enabled
// server-side and silently stays plaintext, which is the live-stack bug this
// reconciles.

import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/getMe/route";
import { db } from "@/lib/db";
import { bots } from "@legends/db/schema";

async function callGetMe(token: string): Promise<Response> {
  return GET(
    new Request("http://t/bot/v1/getMe", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

async function makeBot(opts: {
  ownerUserId: string;
  e2eeState?: "disabled" | "pending" | "ready";
  e2eeDeviceId?: string | null;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(16).toString("hex");
  const [b] = await db
    .insert(bots)
    .values({
      name: `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ownerUserId: opts.ownerUserId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      e2eeState: opts.e2eeState ?? "disabled",
      e2eeDeviceId: opts.e2eeDeviceId ?? null,
    })
    .returning({ id: bots.id });
  return { id: b!.id, token };
}

describe("/api/bot/v1/getMe", () => {
  let ownerId: string;

  beforeAll(async () => {
    ownerId = randomUUID();
    await db.execute(
      sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'gm-owner') ON CONFLICT DO NOTHING`,
    );
  });

  it("returns e2ee_state=disabled and e2ee_device_id=null by default", async () => {
    const { token } = await makeBot({ ownerUserId: ownerId });
    const res = await callGetMe(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.e2ee_state).toBe("disabled");
    expect(body.result.e2ee_device_id).toBeNull();
  });

  it("returns e2ee_state=pending for a bot opted in but not yet uploaded", async () => {
    const { token } = await makeBot({
      ownerUserId: ownerId,
      e2eeState: "pending",
    });
    const res = await callGetMe(token);
    const body = await res.json();
    expect(body.result.e2ee_state).toBe("pending");
    expect(body.result.e2ee_device_id).toBeNull();
  });

  it("returns e2ee_state=ready and the device_id once keys are uploaded", async () => {
    const { token } = await makeBot({
      ownerUserId: ownerId,
      e2eeState: "ready",
      e2eeDeviceId: "BDEVGM",
    });
    const res = await callGetMe(token);
    const body = await res.json();
    expect(body.result.e2ee_state).toBe("ready");
    expect(body.result.e2ee_device_id).toBe("BDEVGM");
  });

  it("returns 401 without a bearer token", async () => {
    const res = await GET(new Request("http://t/bot/v1/getMe"));
    expect(res.status).toBe(401);
  });
});
