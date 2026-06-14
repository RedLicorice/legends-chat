import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state — mutated per test.
const state = {
  currentUser: { id: "admin-1", permissions: new Set(["bots.manage"]) } as
    | { id: string; permissions: Set<string> }
    | null,
  botRows: [] as { id: string }[],
  deletes: [] as Array<{ table: string }>,
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(state.currentUser),
}));

vi.mock("@/lib/db", () => {
  function tableName(table: unknown): string {
    const t = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(t).find((s) =>
      s.toString().includes("Name"),
    );
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
    // Pre-tx lookup: select({ id }).from(bots).where(inArray(...))
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = tableName(table);
          if (name === "bots") {
            return Promise.resolve(state.botRows.map((r) => ({ ...r })));
          }
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        const name = tableName(table);
        state.deletes.push({ table: name });
        return {
          returning: () =>
            Promise.resolve(state.botRows.map((r) => ({ id: r.id }))),
        };
      },
    }),
    transaction: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
  return { db: fakeDb };
});

const { POST } = await import("@/app/api/admin/bots/bulk/route");

function req(body: unknown) {
  return new Request("http://x/api/admin/bots/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  state.currentUser = { id: "admin-1", permissions: new Set(["bots.manage"]) };
  state.botRows = [];
  state.deletes = [];
});

describe("POST /api/admin/bots/bulk", () => {
  it("403 when caller lacks admin.config", async () => {
    state.currentUser = { id: "u", permissions: new Set() };
    const res = await POST(req({ action: "delete", ids: [UUID_A] }));
    expect(res.status).toBe(403);
  });

  it("403 when no current user", async () => {
    state.currentUser = null;
    const res = await POST(req({ action: "delete", ids: [UUID_A] }));
    expect(res.status).toBe(403);
  });

  it("400 on empty ids array", async () => {
    const res = await POST(req({ action: "delete", ids: [] }));
    expect(res.status).toBe(400);
  });

  it("400 on missing action", async () => {
    const res = await POST(req({ ids: [UUID_A] }));
    expect(res.status).toBe(400);
  });

  it("400 on mixed valid + invalid uuid in ids", async () => {
    const res = await POST(
      req({ action: "delete", ids: [UUID_A, "not-a-uuid"] }),
    );
    expect(res.status).toBe(400);
  });

  it("400 when ids array exceeds 200 cap", async () => {
    const ids = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const res = await POST(req({ action: "delete", ids }));
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const r = new Request("http://x/api/admin/bots/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
  });

  it("deletes 3 valid ids — returns ok + count=3, ids list, and wipes scoped overrides + dm_participants + bots", async () => {
    state.botRows = [{ id: UUID_A }, { id: UUID_B }, { id: UUID_C }];
    const res = await POST(
      req({ action: "delete", ids: [UUID_A, UUID_B, UUID_C] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(3);
    expect(new Set(body.ids)).toEqual(new Set([UUID_A, UUID_B, UUID_C]));

    const tables = state.deletes.map((d) => d.table);
    expect(tables).toContain("principal_permission_overrides");
    expect(tables).toContain("dm_participants");
    expect(tables).toContain("bots");
  });

  it("no matching bots — returns ok with deleted=0 and skips delete calls", async () => {
    state.botRows = [];
    const res = await POST(req({ action: "delete", ids: [UUID_A] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(0);
    expect(body.ids).toEqual([]);
    // Short-circuits before opening the transaction.
    expect(state.deletes).toHaveLength(0);
  });
});
