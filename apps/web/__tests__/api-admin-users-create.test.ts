import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state — mutated per test.
const state = {
  currentUser: { id: "admin-1", permissions: new Set(["admin.config"]) } as
    | { id: string; permissions: Set<string> }
    | null,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  nextId: "00000000-0000-4000-8000-000000000001",
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
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = tableName(table);
        state.inserts.push({ table: name, values });
        return {
          returning: () =>
            Promise.resolve([
              {
                id: state.nextId,
                displayName: values.displayName,
                role: values.role,
              },
            ]),
        };
      },
    }),
  };
  return { db: fakeDb };
});

const { POST } = await import("@/app/api/admin/users/route");

function req(body: unknown, opts: { rawBody?: string } = {}) {
  return new Request("http://x/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  state.currentUser = {
    id: "admin-1",
    permissions: new Set(["admin.config"]),
  };
  state.inserts = [];
});

describe("POST /api/admin/users", () => {
  it("403 when caller lacks admin.config", async () => {
    state.currentUser = { id: "u", permissions: new Set() };
    const res = await POST(req({ displayName: "Alice" }));
    expect(res.status).toBe(403);
  });

  it("403 when no current user", async () => {
    state.currentUser = null;
    const res = await POST(req({ displayName: "Alice" }));
    expect(res.status).toBe(403);
  });

  it("400 on missing displayName", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("400 on empty displayName", async () => {
    const res = await POST(req({ displayName: "  " }));
    expect(res.status).toBe(400);
  });

  it("400 on overly long displayName", async () => {
    const res = await POST(req({ displayName: "a".repeat(41) }));
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const res = await POST(req(null, { rawBody: "not-json" }));
    expect(res.status).toBe(400);
  });

  it("200 with valid body — inserts row with provided role", async () => {
    const res = await POST(req({ displayName: "Alice", role: "admin" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Alice");
    expect(body.role).toBe("admin");
    expect(body.id).toBe(state.nextId);

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]!.table).toBe("users");
    expect(state.inserts[0]!.values).toMatchObject({
      displayName: "Alice",
      role: "admin",
      isAnon: false,
    });
  });

  it("200 with default role 'user' when role omitted", async () => {
    const res = await POST(req({ displayName: "Bob" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("user");
    expect(state.inserts[0]!.values).toMatchObject({
      displayName: "Bob",
      role: "user",
      isAnon: false,
    });
  });

  it("200 honours isAnon=true when provided", async () => {
    const res = await POST(req({ displayName: "Anon", isAnon: true }));
    expect(res.status).toBe(200);
    expect(state.inserts[0]!.values).toMatchObject({ isAnon: true });
  });
});
