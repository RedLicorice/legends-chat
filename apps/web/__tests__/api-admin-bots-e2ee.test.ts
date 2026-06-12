import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state — mutated per test.
const state = {
  currentUser: { id: "admin-1", permissions: new Set(["bots.manage"]) } as { id: string; permissions: Set<string> } | null,
  botRow: { id: "bot-1", e2eeState: "disabled" as "disabled" | "pending" | "ready", e2eeDeviceId: null as string | null },
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  deletes: [] as string[],
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  // Finding 11 inputs for rotate's peer-user discovery: tests preload the
  // bot's DM convs (and the convs' user participants) and topic memberships.
  dmConvIds: [] as string[],
  dmUserParticipants: [] as { conversationId: string; userId: string }[],
  topicIdsForBot: [] as string[],
  topicMembersByTopic: {} as Record<string, string[]>,
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
  // Resolve the right row set for each `select().from(table).where()` chain
  // based on which table the call hit. The route uses:
  //   - bots (.limit(1))      → state.botRow
  //   - dm_participants (bot) → state.dmConvIds
  //   - dm_participants (user)→ state.dmUserParticipants for any of dmConvIds
  //   - topic_bots            → state.topicIdsForBot
  //   - topic_members         → flattened state.topicMembersByTopic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function selectFromImpl(table: unknown): any {
    const name = tableName(table);
    const terminate = (): Promise<unknown[]> => {
      if (name === "bots") return Promise.resolve([{ ...state.botRow }]);
      if (name === "dm_participants") {
        // The route issues two distinct queries against dm_participants —
        // first to find conversations the bot is in, then to find user
        // participants of those conversations. We can disambiguate by which
        // shape the test seeded, but the simpler path is to return both sets
        // in order. The route's first call extracts `conversationId`, the
        // second extracts `pid` — different keys mean the unused values on
        // each row are harmless.
        if (selectFromImpl.dmCallCount === 0) {
          selectFromImpl.dmCallCount++;
          return Promise.resolve(
            state.dmConvIds.map((c) => ({ conversationId: c })),
          );
        }
        selectFromImpl.dmCallCount++;
        return Promise.resolve(
          state.dmUserParticipants.map((p) => ({ pid: p.userId })),
        );
      }
      if (name === "topic_bots") {
        return Promise.resolve(state.topicIdsForBot.map((t) => ({ topicId: t })));
      }
      if (name === "topic_members") {
        const all: { userId: string }[] = [];
        for (const memberIds of Object.values(state.topicMembersByTopic)) {
          for (const u of memberIds) all.push({ userId: u });
        }
        return Promise.resolve(all);
      }
      return Promise.resolve([]);
    };
    return {
      where: () => ({
        // `bots` lookup uses .limit(1); other lookups await directly.
        // Awaiting where() returns the terminate() promise; chaining .limit
        // returns the same. We support both by making the returned object
        // both thenable and chainable.
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          terminate().then(resolve, reject),
        limit: () => terminate(),
      }),
    };
  }
  selectFromImpl.dmCallCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeDb: any = {
    select: () => ({
      from: (table: unknown) => selectFromImpl(table),
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
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = tableName(table);
        state.inserts.push({ table: name, values });
        return Promise.resolve();
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        const name = tableName(table);
        state.deletes.push(name);
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
    // Reset hook the test calls between scenarios since selectFromImpl is closed over.
    _resetSelectCounter: () => {
      selectFromImpl.dmCallCount = 0;
    },
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

beforeEach(async () => {
  state.currentUser = { id: "admin-1", permissions: new Set(["bots.manage"]) };
  state.botRow = { id: "bot-1", e2eeState: "disabled", e2eeDeviceId: null };
  state.updates = [];
  state.deletes = [];
  state.inserts = [];
  state.dmConvIds = [];
  state.dmUserParticipants = [];
  state.topicIdsForBot = [];
  state.topicMembersByTopic = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { db } = (await import("@/lib/db")) as unknown as { db: any };
  db._resetSelectCounter?.();
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

  // Finding 11: peers caching the bot's dead device id keep encrypting Olm
  // messages to it after a rotate. Append a user_device_change_log row per
  // peer user so the next /api/crypto/sync surfaces the bot's device under
  // device_lists.changed and the OlmMachine drops the stale device cache.
  it("rotate fans out user_device_change_log rows for every peer user (DM + topic)", async () => {
    state.botRow.e2eeState = "ready";
    state.botRow.e2eeDeviceId = "DEVICE-1";
    state.dmConvIds = ["conv-a"];
    state.dmUserParticipants = [{ conversationId: "conv-a", userId: "user-a" }];
    state.topicIdsForBot = ["topic-x"];
    state.topicMembersByTopic = { "topic-x": ["user-b", "user-c"] };

    const res = await PATCH(req({ rotate: true }), params());
    expect(res.status).toBe(200);

    const logInserts = state.inserts.filter((i) => i.table === "user_device_change_log");
    const insertedUsers = logInserts.map((i) => i.values.userId);
    expect(insertedUsers).toContain("user-a");
    expect(insertedUsers).toContain("user-b");
    expect(insertedUsers).toContain("user-c");
    // Reason must encode the bot id so peers can correlate the change.
    for (const i of logInserts) {
      expect(i.values.reason).toBe("bot_rotate:bot-1");
    }
  });

  it("rotate with no peers inserts zero device_change rows (no-op safe)", async () => {
    state.botRow.e2eeState = "pending";
    state.dmConvIds = [];
    state.topicIdsForBot = [];
    const res = await PATCH(req({ rotate: true }), params());
    expect(res.status).toBe(200);
    const logInserts = state.inserts.filter((i) => i.table === "user_device_change_log");
    expect(logInserts).toHaveLength(0);
  });
});
