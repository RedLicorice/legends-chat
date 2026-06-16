import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock state — mutated per test.
const state = {
  currentUser: { id: "admin-1", permissions: new Set(["admin.config"]) } as
    | { id: string; permissions: Set<string> }
    | null,
  // userExists drives the users-table lookup. authLoginTokensActive seeds
  // the "is there a recent reusable token?" probe; default empty.
  userExists: true as boolean,
  activeTokens: [] as Array<{
    id: string;
    token: string;
    userId: string;
    expiresAt: Date;
    createdAt: Date;
    consumedAt: Date | null;
  }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
};

vi.mock("@/lib/auth", () => ({
  getCurrentUser: () => Promise.resolve(state.currentUser),
}));

vi.mock("@/lib/public-origin.server", () => ({
  publicOriginServer: () => "https://app.example.com",
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
  function selectFromImpl(table: unknown): any {
    const name = tableName(table);
    const terminate = (): Promise<unknown[]> => {
      if (name === "users") {
        return Promise.resolve(state.userExists ? [{ id: "user-1" }] : []);
      }
      if (name === "auth_login_tokens") {
        return Promise.resolve(state.activeTokens.slice());
      }
      return Promise.resolve([]);
    };
    return {
      where: () => ({
        // Both `.limit(1)` and `.orderBy(...).limit(1)` patterns are used.
        limit: () => terminate(),
        orderBy: () => ({ limit: () => terminate() }),
        then: (
          resolve: (v: unknown[]) => unknown,
          reject?: (e: unknown) => unknown,
        ) => terminate().then(resolve, reject),
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeDb: any = {
    select: () => ({
      from: (table: unknown) => selectFromImpl(table),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const name = tableName(table);
          state.updates.push({ table: name, patch });
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = tableName(table);
        state.inserts.push({ table: name, values });
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
  return { db: fakeDb };
});

const { POST } = await import(
  "@/app/api/admin/users/[id]/login-link/route"
);

function req() {
  return new Request("http://x/api/admin/users/user-1/login-link", {
    method: "POST",
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  state.currentUser = {
    id: "admin-1",
    permissions: new Set(["admin.config"]),
  };
  state.userExists = true;
  state.activeTokens = [];
  state.inserts = [];
  state.updates = [];
});

describe("POST /api/admin/users/[id]/login-link", () => {
  it("403 when caller lacks admin.config", async () => {
    state.currentUser = { id: "u", permissions: new Set() };
    const res = await POST(req(), {
      params: Promise.resolve({ id: "user-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("403 when no current user", async () => {
    state.currentUser = null;
    const res = await POST(req(), {
      params: Promise.resolve({ id: "user-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when user does not exist", async () => {
    state.userExists = false;
    const res = await POST(req(), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 returns token + url + expiresAt; inserts auth_login_tokens row", async () => {
    const res = await POST(req(), {
      params: Promise.resolve({ id: "user-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(typeof body.expiresAt).toBe("string");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.url).toBe(
      `https://app.example.com/auth/callback?token=${body.token}`,
    );

    const tokenInserts = state.inserts.filter(
      (i) => i.table === "auth_login_tokens",
    );
    expect(tokenInserts).toHaveLength(1);
    expect(tokenInserts[0]!.values).toMatchObject({
      userId: "user-1",
      token: body.token,
    });
  });

  it("URL is built from origin + /auth/callback?token=<token>", async () => {
    const res = await POST(req(), {
      params: Promise.resolve({ id: "user-1" }),
    });
    const body = await res.json();
    const parsed = new URL(body.url);
    expect(parsed.origin).toBe("https://app.example.com");
    expect(parsed.pathname).toBe("/auth/callback");
    expect(parsed.searchParams.get("token")).toBe(body.token);
  });

  it("reuses an existing token issued within the reuse window", async () => {
    const now = Date.now();
    const existing = {
      id: "tok-1",
      token: "EXISTING_TOKEN_VALUE",
      userId: "user-1",
      expiresAt: new Date(now + 4 * 60 * 1000),
      createdAt: new Date(now - 5_000), // 5s old, < 15s reuse window
      consumedAt: null,
    };
    state.activeTokens = [existing];

    const res = await POST(req(), {
      params: Promise.resolve({ id: "user-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe("EXISTING_TOKEN_VALUE");
    // No new token insert when reusing.
    expect(state.inserts.filter((i) => i.table === "auth_login_tokens")).toHaveLength(0);
  });
});
