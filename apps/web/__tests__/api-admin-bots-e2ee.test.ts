import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state — mutated per test.
const state = {
  currentUser: { id: "admin-1", permissions: new Set(["bots.manage"]) } as { id: string; permissions: Set<string> } | null,
  botRow: { id: "bot-1", e2eeState: "disabled" as "disabled" | "pending" | "ready", e2eeDeviceId: null as string | null },
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  deletes: [] as string[],
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(state.currentUser),
}));

vi.mock("@/lib/db", () => {
  function tableName(table: unknown): string {
    const t = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(t).find((s) => s.toString().includes("Name"));
    if (sym) {
      const name = (t as Record<symbol, unknown>)[sym];
      if (typeof name === "string") return name;
    }
    const meta = t._ as { name?: string } | undefined;
    if (meta?.name) return meta.name;
    if (typeof t.tableName === "string") return t.tableName;
    return "?";
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeDb: any = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ ...state.botRow }]),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            const name = tableName(table);
            state.updates.push({ table: name, patch });
            const next = { ...state.botRow, ...patch };
            state.botRow = next as typeof state.botRow;
            return Promise.resolve([next]);
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        const name = tableName(table);
        state.deletes.push(name);
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
  };
  return { db: fakeDb };
});

const { PATCH } = await import("@/app/api/admin/bots/[id]/e2ee/route");

function req(body: unknown) {
  return new Request("http://x/api/admin/bots/bot-1/e2ee", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function params() { return { params: Promise.resolve({ id: "bot-1" }) }; }

beforeEach(() => {
  state.currentUser = { id: "admin-1", permissions: new Set(["bots.manage"]) };
  state.botRow = { id: "bot-1", e2eeState: "disabled", e2eeDeviceId: null };
  state.updates = [];
  state.deletes = [];
});

describe("PATCH /api/admin/bots/[id]/e2ee", () => {
  it("403 when caller lacks bots.manage", async () => {
    state.currentUser = { id: "u", permissions: new Set() };
    const res = await PATCH(req({ enabled: true }), params());
    expect(res.status).toBe(403);
  });

  it("400 on invalid body (neither enabled nor rotate)", async () => {
    const res = await PATCH(req({}), params());
    expect(res.status).toBe(400);
  });

  it("400 on invalid body (both enabled and rotate)", async () => {
    const res = await PATCH(req({ enabled: true, rotate: true }), params());
    expect(res.status).toBe(400);
  });

  it("disabled -> pending when enabled:true", async () => {
    state.botRow.e2eeState = "disabled";
    const res = await PATCH(req({ enabled: true }), params());
    expect(res.status).toBe(200);
    expect(state.updates.some((u) => u.patch.e2eeState === "pending")).toBe(true);
    const body = await res.json();
    expect(body.e2ee_state).toBe("pending");
  });

  it("pending -> pending (no-op) when enabled:true", async () => {
    state.botRow.e2eeState = "pending";
    const res = await PATCH(req({ enabled: true }), params());
    expect(res.status).toBe(200);
    expect(state.updates.length).toBe(0);
  });

  it("ready -> ready (no-op) when enabled:true", async () => {
    state.botRow.e2eeState = "ready";
    state.botRow.e2eeDeviceId = "DEVICE-1";
    const res = await PATCH(req({ enabled: true }), params());
    expect(res.status).toBe(200);
    expect(state.updates.length).toBe(0);
  });

  it("ready -> disabled when enabled:false (keeps device_id)", async () => {
    state.botRow.e2eeState = "ready";
    state.botRow.e2eeDeviceId = "DEVICE-1";
    const res = await PATCH(req({ enabled: false }), params());
    expect(res.status).toBe(200);
    expect(state.updates.some((u) => u.patch.e2eeState === "disabled")).toBe(true);
    expect(state.deletes.length).toBe(0);
    const body = await res.json();
    expect(body.e2ee_device_id).toBe("DEVICE-1");
  });

  it("rotate:true -> wipes tables + state=pending + clears device_id", async () => {
    state.botRow.e2eeState = "ready";
    state.botRow.e2eeDeviceId = "DEVICE-1";
    const res = await PATCH(req({ rotate: true }), params());
    expect(res.status).toBe(200);
    const tables = state.deletes;
    expect(tables).toContain("bot_devices");
    expect(tables).toContain("bot_one_time_keys");
    expect(tables).toContain("bot_to_device_queue");
    expect(tables).toContain("bot_crypto_sent_txns");
    const patches = state.updates.flatMap((u) => Object.entries(u.patch));
    expect(patches).toContainEqual(["e2eeState", "pending"]);
    expect(patches).toContainEqual(["e2eeDeviceId", null]);
    const body = await res.json();
    expect(body.e2ee_state).toBe("pending");
    expect(body.e2ee_device_id).toBeNull();
  });
});
