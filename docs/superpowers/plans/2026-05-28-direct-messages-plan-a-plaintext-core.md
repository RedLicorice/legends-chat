# Direct Messages — Plan A: Plaintext user↔user core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 1:1 plaintext direct messages between users (discovery, request/accept, send/receive, sidebar tabs) as a self-contained subsystem that does not touch the existing topics/messages/group-E2EE machinery.

**Architecture:** New DB tables (`dm_conversations`, `dm_participants`, `dm_messages`, `dm_blocks`) and a thin web data layer. Messages are stored at-rest-encrypted (mirroring the existing `messages` insert path) but plaintext-to-the-server. Sends go through Next.js route handlers, which insert the row and `redis.publish` a `DM_*` channel; `apps/ws` relays to each participant's `user:<id>` socket room (the same cross-process pattern bot messages use). UI is a dedicated DM surface, not `TopicView`.

**Tech Stack:** Next.js 15 (App Router), Drizzle ORM + Postgres, ioredis pub/sub, socket.io (`apps/ws`), Tailwind theme tokens, zod, lucide-react. Spec: `docs/superpowers/specs/2026-05-28-direct-messages-design.md`.

**Scope of Plan A (and what is deferred):** Plaintext user↔user only. NO E2EE (`dm_sender_keys`, `/keys` route, encrypted thread client) — that is Plan B. NO bots — that is Plan C. The `dm_conversations.isE2ee` column is created now (default `false`) and always `false` in Plan A so Plan B is additive. `dm_participants` already uses a principal model (`principalType`) so Plan C (bots) is additive.

---

## Test / verification strategy (READ FIRST — judgment call)

This repo has **no test runner** (no vitest/jest/playwright, zero test files; CI is build+lint+typecheck only). Rather than impose full TDD infrastructure on a websocket/DB subsystem with no harness, Plan A uses:

1. **vitest in `packages/db`** — added once in Task 1 — for **pure-logic units only** (no DB, no network): `dmKey` derivation and the content codec. These are real failing-test-first TDD.
2. **`pnpm -r typecheck`** (`tsc --noEmit`) — the repo's primary correctness gate — after every task that adds TS.
3. **Runnable `tsx` smoke scripts** under `packages/db/src/scripts/` for DB-backed paths (idempotent conversation creation, participant guards), run against the dev Postgres.
4. **Manual browser verification** for UI (the repo's established practice), with explicit steps.

If you would rather NOT add vitest, replace the Task-1 vitest setup with `tsx` assertion scripts for the same two pure units and drop the `*.test.ts` files — the rest of the plan is unchanged. Decide before starting Task 1.

**Commands used throughout:**
- Typecheck one package: `pnpm --filter @legends/web typecheck` (or `@legends/db`, `@legends/ws`, `@legends/shared`).
- Typecheck all: `pnpm -r typecheck`.
- Run a single vitest file: `pnpm --filter @legends/db test src/dm-key.test.ts` (script added in Task 1).
- Apply migrations: `pnpm db:migrate`.
- Run a smoke script: `pnpm --filter @legends/db exec tsx src/scripts/<name>.ts`.
- Dev servers (manual checks): `pnpm --filter @legends/web dev` (port 3000) and `pnpm --filter @legends/ws dev`.

Assume a dev Postgres + Redis are running (per `docker-compose.yml`) and `DATABASE_URL`/`REDIS_URL`/`ENCRYPTION_MASTER_KEY` are set in the environment the commands inherit.

---

## File structure

**Create:**
- `packages/db/vitest.config.ts` — vitest config (pure-logic units).
- `packages/db/src/dm-key.ts` — `buildDmKey(a, b)` principal-pair key derivation (pure).
- `packages/db/src/dm-key.test.ts` — tests for `buildDmKey`.
- `packages/db/src/migrations/0035_direct_messages.sql` — hand-written migration.
- `packages/db/src/scripts/dm-smoke.ts` — DB smoke test for conversation create/idempotency.
- `apps/web/lib/dm.ts` — server-side DM helpers (create/open, list, send, guards).
- `apps/web/lib/dm.codec.ts` — DM message content codec (plain text passthrough; isolation point for Plan B envelopes).
- `apps/web/lib/dm.codec.test.ts` — codec tests (run via web's vitest if present, else moved to db pkg; see Task 6).
- `apps/web/app/api/dm/route.ts` — `GET` list, `POST` open.
- `apps/web/app/api/dm/search/route.ts` — `GET` user search (rate-limited).
- `apps/web/app/api/dm/[id]/messages/route.ts` — `GET` history, `POST` send.
- `apps/web/app/api/dm/[id]/accept/route.ts` — `POST`.
- `apps/web/app/api/dm/[id]/block/route.ts` — `POST`.
- `apps/web/app/api/dm/[id]/read/route.ts` — `POST`.
- `apps/web/app/dm/page.tsx` — server page (auth gate + initial list) hosting the DM client.
- `apps/web/components/DmClient.tsx` — `"use client"` shell: list + requests + thread + new-DM search.
- `apps/web/hooks/useDmSocket.ts` — subscribe to `DM_*` ws events.

**Modify:**
- `packages/db/src/schema.ts` — add DM tables + enum.
- `packages/db/src/migrations/meta/_journal.json` — append the 0035 entry.
- `packages/db/package.json` — add `test` + `test:run` scripts, vitest devDep.
- `packages/shared/src/events.ts` — add `DM_*` to `WS_EVENTS` + `REDIS_CHANNELS`.
- `apps/ws/src/index.ts` — subscribe + relay `DM_*` channels to `user:<id>` rooms.
- `apps/web/components/AppSidebar.tsx` — add a "Direct Messages" entry to the chat sidebar.

**Untouched (by design):** `messages`, `topics`, `topicMembers`, `topicBots`, `e2eeSenderKeys`, `TopicView`, group-E2EE routes, `apps/web/app/api/bot/v1/*`.

---

## Task 1: DB schema, migration, and vitest setup

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0035_direct_messages.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/package.json`
- Create: `packages/db/vitest.config.ts`
- Create: `packages/db/src/dm-key.ts`
- Create: `packages/db/src/dm-key.test.ts`

- [ ] **Step 1: Add the DM tables to `schema.ts`**

Append to the end of `packages/db/src/schema.ts` (it already imports `pgTable, pgEnum, uuid, text, timestamp, boolean, integer, bigint, bigserial, jsonb, index, uniqueIndex, primaryKey` and `sql` — reuse them; do not re-import):

```ts
// ── Direct messages (1:1) ─────────────────────────────────────────────────────
export const dmPrincipalType = pgEnum("dm_principal_type", ["user", "bot"]);
export const dmState = pgEnum("dm_state", ["pending", "accepted", "blocked"]);

export const dmConversations = pgTable(
  "dm_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dmKey: text("dm_key").notNull(),
    isE2ee: boolean("is_e2ee").notNull().default(false),
    state: dmState("state").notNull().default("pending"),
    initiatorType: dmPrincipalType("initiator_type").notNull(),
    initiatorId: text("initiator_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (t) => ({
    dmKeyIdx: uniqueIndex("dm_conversations_dm_key_idx").on(t.dmKey),
  }),
);

export const dmParticipants = pgTable(
  "dm_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => dmConversations.id, { onDelete: "cascade" }),
    principalType: dmPrincipalType("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    lastReadMessageId: bigint("last_read_message_id", { mode: "bigint" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.principalType, t.principalId] }),
    principalIdx: index("dm_participants_principal_idx").on(t.principalType, t.principalId),
  }),
);

export const dmMessages = pgTable(
  "dm_messages",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => dmConversations.id, { onDelete: "cascade" }),
    senderType: dmPrincipalType("sender_type").notNull(),
    senderId: text("sender_id").notNull(),
    contentCiphertext: bytea("content_ciphertext").notNull(),
    contentNonce: bytea("content_nonce").notNull(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => encryptionKeys.id),
    replyToMessageId: bigint("reply_to_message_id", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    convCreatedIdx: index("dm_messages_conv_created_idx").on(t.conversationId, t.id),
  }),
);

export const dmBlocks = pgTable(
  "dm_blocks",
  {
    blockerUserId: uuid("blocker_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }),
  }),
);
```

Note: `bytea` is the module-private custom type already defined near the top of `schema.ts`; `encryptionKeys` and `users` are already defined above. This block must appear AFTER those definitions (end of file is safe).

- [ ] **Step 2: Write the hand-written migration SQL**

Create `packages/db/src/migrations/0035_direct_messages.sql` (this repo hand-writes migrations with `IF NOT EXISTS`; do not rely on `drizzle-kit generate`):

```sql
-- Direct messages (1:1) subsystem — plaintext core (Plan A)
CREATE TYPE "dm_principal_type" AS ENUM ('user', 'bot');
CREATE TYPE "dm_state" AS ENUM ('pending', 'accepted', 'blocked');

CREATE TABLE IF NOT EXISTS "dm_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dm_key" text NOT NULL,
  "is_e2ee" boolean DEFAULT false NOT NULL,
  "state" "dm_state" DEFAULT 'pending' NOT NULL,
  "initiator_type" "dm_principal_type" NOT NULL,
  "initiator_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "dm_conversations_dm_key_idx" ON "dm_conversations" ("dm_key");

CREATE TABLE IF NOT EXISTS "dm_participants" (
  "conversation_id" uuid NOT NULL REFERENCES "dm_conversations"("id") ON DELETE CASCADE,
  "principal_type" "dm_principal_type" NOT NULL,
  "principal_id" text NOT NULL,
  "last_read_message_id" bigint,
  CONSTRAINT "dm_participants_pk" PRIMARY KEY ("conversation_id", "principal_type", "principal_id")
);
CREATE INDEX IF NOT EXISTS "dm_participants_principal_idx" ON "dm_participants" ("principal_type", "principal_id");

CREATE TABLE IF NOT EXISTS "dm_messages" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "dm_conversations"("id") ON DELETE CASCADE,
  "sender_type" "dm_principal_type" NOT NULL,
  "sender_id" text NOT NULL,
  "content_ciphertext" "bytea" NOT NULL,
  "content_nonce" "bytea" NOT NULL,
  "key_id" uuid NOT NULL REFERENCES "encryption_keys"("id"),
  "reply_to_message_id" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "dm_messages_conv_created_idx" ON "dm_messages" ("conversation_id", "id");

CREATE TABLE IF NOT EXISTS "dm_blocks" (
  "blocker_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dm_blocks_pk" PRIMARY KEY ("blocker_user_id", "blocked_user_id")
);
```

Note: `bytea` columns reference the SQL type `bytea` (Postgres built-in); the quoted `"bytea"` mirrors how drizzle emits it. If your Postgres rejects quoted `"bytea"`, use unquoted `bytea`. The existing migrations use unquoted built-in types, so prefer `content_ciphertext bytea NOT NULL`.

- [ ] **Step 3: Append the journal entry**

Open `packages/db/src/migrations/meta/_journal.json`. It has an `entries` array; the last entry is `idx: 34`. Append a new object (keep the existing ones unchanged):

```json
{
  "idx": 35,
  "version": "7",
  "when": 1779600000000,
  "tag": "0035_direct_messages",
  "breakpoints": true
}
```

(Use the next `when` value above the previous entry's; `1779600000000` is past the prior `1779500000000`.)

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:migrate`
Expected: prints `migrations applied` with no error. Verify tables exist:
Run: `pnpm --filter @legends/db exec tsx -e "import postgres from 'postgres'; const s=postgres(process.env.DATABASE_URL); console.log(await s\`select table_name from information_schema.tables where table_name like 'dm_%' order by 1\`); await s.end();"`
Expected: lists `dm_blocks, dm_conversations, dm_messages, dm_participants`.

- [ ] **Step 5: Add vitest to `packages/db`**

In `packages/db/package.json`, add to `scripts`: `"test": "vitest", "test:run": "vitest run"`, and add `"vitest": "^2.1.0"` to `devDependencies`. Then:
Run: `pnpm install`
Create `packages/db/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 6: Write the failing test for `buildDmKey`**

Create `packages/db/src/dm-key.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDmKey } from "./dm-key";

describe("buildDmKey", () => {
  it("is order-independent (same pair → same key)", () => {
    const a = buildDmKey({ type: "user", id: "11111111-1111-1111-1111-111111111111" }, { type: "user", id: "22222222-2222-2222-2222-222222222222" });
    const b = buildDmKey({ type: "user", id: "22222222-2222-2222-2222-222222222222" }, { type: "user", id: "11111111-1111-1111-1111-111111111111" });
    expect(a).toBe(b);
  });

  it("encodes principal type in the key", () => {
    const k = buildDmKey({ type: "user", id: "aaa" }, { type: "bot", id: "bbb" });
    expect(k).toBe("b:bbb|u:aaa");
  });

  it("distinguishes a user and a bot with the same id", () => {
    const k1 = buildDmKey({ type: "user", id: "x" }, { type: "user", id: "y" });
    const k2 = buildDmKey({ type: "user", id: "x" }, { type: "bot", id: "y" });
    expect(k1).not.toBe(k2);
  });

  it("rejects a self-pair", () => {
    expect(() => buildDmKey({ type: "user", id: "x" }, { type: "user", id: "x" })).toThrow();
  });
});
```

- [ ] **Step 7: Run the test to confirm it fails**

Run: `pnpm --filter @legends/db test:run src/dm-key.test.ts`
Expected: FAIL — `Failed to resolve import "./dm-key"` / `buildDmKey is not a function`.

- [ ] **Step 8: Implement `buildDmKey`**

Create `packages/db/src/dm-key.ts`:

```ts
export type DmPrincipal = { type: "user" | "bot"; id: string };

function token(p: DmPrincipal): string {
  return `${p.type === "bot" ? "b" : "u"}:${p.id}`;
}

/**
 * Deterministic, order-independent key identifying a 1:1 conversation between
 * two principals. Used as a UNIQUE constraint so opening a DM is idempotent.
 */
export function buildDmKey(a: DmPrincipal, b: DmPrincipal): string {
  const ta = token(a);
  const tb = token(b);
  if (ta === tb) throw new Error("cannot open a DM with self");
  return ta < tb ? `${ta}|${tb}` : `${tb}|${ta}`;
}
```

- [ ] **Step 9: Run the test to confirm it passes**

Run: `pnpm --filter @legends/db test:run src/dm-key.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm --filter @legends/db typecheck`
Expected: no errors.

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/0035_direct_messages.sql packages/db/src/migrations/meta/_journal.json packages/db/package.json packages/db/vitest.config.ts packages/db/src/dm-key.ts packages/db/src/dm-key.test.ts pnpm-lock.yaml
git commit -m "feat(dm): schema + migration for direct messages, dmKey helper"
```

---

## Task 2: Shared ws events + redis channels

**Files:**
- Modify: `packages/shared/src/events.ts`

- [ ] **Step 1: Add DM events**

In `packages/shared/src/events.ts`, inside `WS_EVENTS`, add to the `server -> client` group (after `SIDEBAR_UPDATE`):

```ts
  DM_NEW: "dm:new",
  DM_EDIT: "dm:edit",
  DM_DELETE: "dm:delete",
  DM_READ: "dm:read",
  DM_REQUEST: "dm:request",
```

Inside `REDIS_CHANNELS`, add (after `SYMBOLS_UPDATE`):

```ts
  DM_MESSAGE_NEW: "legends:dm:message:new",
  DM_MESSAGE_EDIT: "legends:dm:message:edit",
  DM_MESSAGE_DELETE: "legends:dm:message:delete",
  DM_REQUEST_NEW: "legends:dm:request:new",
```

- [ ] **Step 2: Typecheck and commit**

Run: `pnpm --filter @legends/shared typecheck && pnpm --filter @legends/web typecheck`
Expected: no errors.

```bash
git add packages/shared/src/events.ts
git commit -m "feat(dm): add DM ws events + redis channels"
```

---

## Task 3: Server DM helpers (`apps/web/lib/dm.ts`) + codec

**Files:**
- Create: `apps/web/lib/dm.codec.ts`
- Create: `apps/web/lib/dm.ts`
- Create: `packages/db/src/scripts/dm-smoke.ts`

This task has no web-side unit test runner (web has no vitest). The codec is pure and is unit-tested by relocating its test into `packages/db`'s runner is not possible (different package). Instead: codec correctness is covered by the `tsx` smoke script in Step 4 + typecheck. Keep the codec trivially correct.

- [ ] **Step 1: Write the content codec (isolation point for Plan B)**

Create `apps/web/lib/dm.codec.ts`:

```ts
// DM message content codec. Plan A stores plaintext (server-readable). The
// codec exists as the single isolation point so Plan B can swap in an E2EE
// envelope without touching the insert/read paths.
export function encodeDmContent(text: string): string {
  return text;
}

export function decodeDmContent(raw: string): string {
  return raw;
}
```

- [ ] **Step 2: Write the server DM helper**

Create `apps/web/lib/dm.ts`:

```ts
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { dmConversations, dmParticipants, dmMessages, dmBlocks, encryptionKeys, users } from "@legends/db/schema";
import { generateDataKey, wrapKey, unwrapKey, encryptMessage, decryptMessage } from "@legends/crypto";
import { buildDmKey, type DmPrincipal } from "@legends/db/dm-key";
import { db } from "@/lib/db";
import { encodeDmContent, decodeDmContent } from "@/lib/dm.codec";

// ── data key (cached) — mirrors apps/ws/src/messages.ts currentDataKey ────────
let cachedKey: { id: string; data: Uint8Array } | null = null;
async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  if (cachedKey) return cachedKey;
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.purpose, "messages")).orderBy(desc(encryptionKeys.createdAt)).limit(1);
  if (rows[0]) {
    cachedKey = { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
    return cachedKey;
  }
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped }).returning();
  cachedKey = { id: inserted!.id, data };
  return cachedKey;
}
const keyDataCache = new Map<string, Uint8Array>();
async function getKeyData(keyId: string): Promise<Uint8Array> {
  const hit = keyDataCache.get(keyId);
  if (hit) return hit;
  const [row] = await db.select().from(encryptionKeys).where(eq(encryptionKeys.id, keyId)).limit(1);
  if (!row) throw new Error("encryption key not found");
  const data = unwrapKey(row.wrappedKey);
  keyDataCache.set(keyId, data);
  return data;
}

export type DmMessageView = {
  id: string;
  conversationId: string;
  senderType: "user" | "bot";
  senderId: string;
  text: string;
  replyToMessageId: string | null;
  createdAt: string;
  editedAt: string | null;
};

export type DmConversationView = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean; // true if the current user is the recipient of a pending request
};

function userPrincipal(userId: string): DmPrincipal {
  return { type: "user", id: userId };
}

export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ blocker: dmBlocks.blockerUserId })
    .from(dmBlocks)
    .where(or(and(eq(dmBlocks.blockerUserId, a), eq(dmBlocks.blockedUserId, b)), and(eq(dmBlocks.blockerUserId, b), eq(dmBlocks.blockedUserId, a))));
  return rows.length > 0;
}

export async function assertParticipant(conversationId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, userId)))
    .limit(1);
  if (rows.length === 0) throw Object.assign(new Error("not a participant"), { code: "FORBIDDEN" });
}

// Open (or fetch) a user↔user conversation idempotently.
export async function openUserConversation(initiatorId: string, peerId: string): Promise<{ id: string; created: boolean }> {
  if (initiatorId === peerId) throw Object.assign(new Error("cannot DM yourself"), { code: "BAD" });
  if (await isBlockedBetween(initiatorId, peerId)) throw Object.assign(new Error("blocked"), { code: "BLOCKED" });
  const dmKey = buildDmKey(userPrincipal(initiatorId), userPrincipal(peerId));
  const existing = await db.select({ id: dmConversations.id }).from(dmConversations).where(eq(dmConversations.dmKey, dmKey)).limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const [conv] = await db
    .insert(dmConversations)
    .values({ dmKey, isE2ee: false, state: "pending", initiatorType: "user", initiatorId })
    .onConflictDoNothing({ target: dmConversations.dmKey })
    .returning({ id: dmConversations.id });
  if (!conv) {
    // race: someone created it between SELECT and INSERT — fetch it
    const [row] = await db.select({ id: dmConversations.id }).from(dmConversations).where(eq(dmConversations.dmKey, dmKey)).limit(1);
    return { id: row!.id, created: false };
  }
  await db.insert(dmParticipants).values([
    { conversationId: conv.id, principalType: "user", principalId: initiatorId },
    { conversationId: conv.id, principalType: "user", principalId: peerId },
  ]).onConflictDoNothing();
  return { id: conv.id, created: true };
}

export async function listConversations(userId: string): Promise<DmConversationView[]> {
  // conversations where the user participates
  const myConvs = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, userId)));
  const ids = myConvs.map((c) => c.conversationId);
  if (ids.length === 0) return [];

  const convs = await db.select().from(dmConversations).where(inArray(dmConversations.id, ids));
  const parts = await db.select().from(dmParticipants).where(inArray(dmParticipants.conversationId, ids));
  const peerIds = parts.filter((p) => p.principalType === "user" && p.principalId !== userId).map((p) => p.principalId);
  const peerRows = peerIds.length
    ? await db.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, peerIds))
    : [];
  const peerById = new Map(peerRows.map((u) => [u.id, u]));

  return convs.map((c) => {
    const peerPart = parts.find((p) => p.conversationId === c.id && p.principalType === "user" && p.principalId !== userId);
    const peer = peerPart ? peerById.get(peerPart.principalId) ?? null : null;
    return {
      id: c.id,
      state: c.state,
      isE2ee: c.isE2ee,
      peer: peer ? { id: peer.id, displayName: peer.displayName, avatarUrl: peer.avatarUrl } : null,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      incoming: c.state === "pending" && c.initiatorId !== userId,
    };
  });
}

export async function listMessages(conversationId: string, beforeId?: string, limit = 50): Promise<DmMessageView[]> {
  const where = beforeId
    ? and(eq(dmMessages.conversationId, conversationId), lt(dmMessages.id, BigInt(beforeId)))
    : eq(dmMessages.conversationId, conversationId);
  const rows = await db.select().from(dmMessages).where(where).orderBy(desc(dmMessages.id)).limit(limit);
  const out: DmMessageView[] = [];
  for (const r of rows.reverse()) {
    const keyData = await getKeyData(r.keyId);
    const aad = new TextEncoder().encode(conversationId);
    const raw = r.deletedAt ? "" : decryptMessage(keyData, r.contentCiphertext, r.contentNonce, aad);
    out.push({
      id: r.id.toString(),
      conversationId,
      senderType: r.senderType,
      senderId: r.senderId,
      text: r.deletedAt ? "" : decodeDmContent(raw),
      replyToMessageId: r.replyToMessageId ? r.replyToMessageId.toString() : null,
      createdAt: r.createdAt.toISOString(),
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    });
  }
  return out;
}

export async function insertDmMessage(args: {
  conversationId: string;
  senderType: "user" | "bot";
  senderId: string;
  text: string;
  replyToMessageId?: string | null;
}): Promise<DmMessageView> {
  const key = await currentDataKey();
  const aad = new TextEncoder().encode(args.conversationId);
  const { ciphertext, nonce } = encryptMessage(key.data, encodeDmContent(args.text), aad);
  const [row] = await db
    .insert(dmMessages)
    .values({
      conversationId: args.conversationId,
      senderType: args.senderType,
      senderId: args.senderId,
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      keyId: key.id,
      replyToMessageId: args.replyToMessageId ? BigInt(args.replyToMessageId) : null,
    })
    .returning();
  await db.update(dmConversations).set({ lastMessageAt: row!.createdAt }).where(eq(dmConversations.id, args.conversationId));
  return {
    id: row!.id.toString(),
    conversationId: args.conversationId,
    senderType: args.senderType,
    senderId: args.senderId,
    text: args.text,
    replyToMessageId: args.replyToMessageId ?? null,
    createdAt: row!.createdAt.toISOString(),
    editedAt: null,
  };
}

export async function recipientUserIds(conversationId: string, exceptUserId?: string): Promise<string[]> {
  const rows = await db
    .select({ pid: dmParticipants.principalId, ptype: dmParticipants.principalType })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversationId, conversationId));
  return rows.filter((r) => r.ptype === "user" && r.pid !== exceptUserId).map((r) => r.pid);
}
```

Note: this imports `@legends/db/dm-key`. Add that subpath export — see Step 3.

- [ ] **Step 3: Export `dm-key` from `@legends/db`**

In `packages/db/package.json`, the `exports` map exposes `.`, `./schema`, etc. Add an entry:

```json
"./dm-key": "./src/dm-key.ts"
```

(Place it alongside the existing `"./schema"` export entry, matching its format — e.g. `"./dm-key": { "types": "./src/dm-key.ts", "default": "./src/dm-key.ts" }` if the others use that object form; copy the exact shape used by `"./schema"`.)

- [ ] **Step 4: Write the DB smoke script**

Create `packages/db/src/scripts/dm-smoke.ts`:

```ts
// Smoke test: idempotent conversation creation + participant rows.
// Run: pnpm --filter @legends/db exec tsx src/scripts/dm-smoke.ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { buildDmKey } from "./dm-key";

const url = process.env.DATABASE_URL ?? "postgres://legends:legends@localhost:5432/legends";
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema });

async function main() {
  // pick two real users
  const us = await db.select({ id: schema.users.id }).from(schema.users).limit(2);
  if (us.length < 2) throw new Error("need 2 users in DB to smoke test");
  const [a, b] = [us[0]!.id, us[1]!.id];
  const dmKey = buildDmKey({ type: "user", id: a }, { type: "user", id: b });

  // clean any prior
  await db.delete(schema.dmConversations).where(eq(schema.dmConversations.dmKey, dmKey));

  const [c1] = await db.insert(schema.dmConversations).values({ dmKey, initiatorType: "user", initiatorId: a }).onConflictDoNothing({ target: schema.dmConversations.dmKey }).returning();
  const [c2] = await db.insert(schema.dmConversations).values({ dmKey, initiatorType: "user", initiatorId: a }).onConflictDoNothing({ target: schema.dmConversations.dmKey }).returning();
  console.assert(c1 && !c2, "second insert must be a no-op (idempotent dmKey)");
  console.log("idempotent conversation OK:", c1!.id);

  await db.delete(schema.dmConversations).where(eq(schema.dmConversations.dmKey, dmKey));
  console.log("smoke OK");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Run the smoke script**

Run: `pnpm --filter @legends/db exec tsx src/scripts/dm-smoke.ts`
Expected: prints `idempotent conversation OK: <uuid>` then `smoke OK`. (Requires ≥2 users in the dev DB; seed if needed via `pnpm db:seed`.)

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @legends/web typecheck && pnpm --filter @legends/db typecheck`
Expected: no errors.

```bash
git add apps/web/lib/dm.ts apps/web/lib/dm.codec.ts packages/db/package.json packages/db/src/scripts/dm-smoke.ts
git commit -m "feat(dm): server DM helpers (open/list/insert/guards) + content codec"
```

---

## Task 4: API — open + list conversations (`/api/dm`)

**Files:**
- Create: `apps/web/app/api/dm/route.ts`

- [ ] **Step 1: Implement the route**

Create `apps/web/app/api/dm/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { openUserConversation, listConversations } from "@/lib/dm";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conversations = await listConversations(user.id);
  return NextResponse.json({ conversations });
}

const openSchema = z.object({
  peerType: z.literal("user"), // Plan A: user↔user only. Plan C adds "bot".
  peerId: z.string().uuid(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = openSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const { id, created } = await openUserConversation(user.id, parsed.data.peerId);
    return NextResponse.json({ id, created }, { status: created ? 201 : 200 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "BLOCKED") return NextResponse.json({ error: "blocked" }, { status: 403 });
    if (code === "BAD") return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    throw e;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verify (after Task 9 UI exists, or via curl now)**

Run (replace cookie + peer uuid with a real session + user id):
`curl -s -X POST http://localhost:3000/api/dm -H 'content-type: application/json' -H 'cookie: lc_access=<token>' -d '{"peerType":"user","peerId":"<uuid>"}' -w "\n%{http_code}"`
Expected: `{"id":"<uuid>","created":true}` and `201` first call, `200` on repeat (idempotent).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/dm/route.ts
git commit -m "feat(dm): POST open + GET list conversations route"
```

---

## Task 5: API — user search (`/api/dm/search`, rate-limited)

**Files:**
- Create: `apps/web/app/api/dm/search/route.ts`

- [ ] **Step 1: Implement the route**

Create `apps/web/app/api/dm/search/route.ts` (reuses the `ilike` logic from `/api/users` but drops the admin gate, excludes self + anon, and rate-limits):

```ts
import { NextResponse } from "next/server";
import { and, ilike, ne, eq } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const minuteKey = `dm:search:${user.id}:m:${Math.floor(Date.now() / 60000)}`;
  const rl = await checkAndIncrement(minuteKey, 30, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json({ error: "rate limit exceeded", retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);

  const rows = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(and(ilike(users.displayName, `%${q}%`), ne(users.id, user.id), eq(users.isAnon, false)))
    .limit(8);
  return NextResponse.json(rows);
}
```

Note: confirm `users.isAnon` is the correct column name in `schema.ts` (the `CurrentUser.isAnon` field is derived from it). If the column is named differently (e.g. `is_anon` → `isAnon`), match the schema key. If anon users are not a column but a role, replace the `eq(users.isAnon, false)` clause with the equivalent role filter.

- [ ] **Step 2: Typecheck + manual verify**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.
Manual: `curl -s 'http://localhost:3000/api/dm/search?q=al' -H 'cookie: lc_access=<token>'` → JSON array of ≤8 users, excluding yourself. Hammer >30×/min → `429`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/dm/search/route.ts
git commit -m "feat(dm): rate-limited user search route"
```

---

## Task 6: API — messages history + send (`/api/dm/[id]/messages`)

**Files:**
- Create: `apps/web/app/api/dm/[id]/messages/route.ts`

- [ ] **Step 1: Implement the route**

Create `apps/web/app/api/dm/[id]/messages/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { REDIS_CHANNELS } from "@legends/shared";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, listMessages, insertDmMessage, recipientUserIds, isBlockedBetween } from "@/lib/dm";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  const messages = await listMessages(id, before);
  return NextResponse.json({ messages });
}

const sendSchema = z.object({
  text: z.string().min(1).max(8000),
  replyToMessageId: z.string().optional().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conv.state === "blocked") return NextResponse.json({ error: "blocked" }, { status: 403 });
  if (conv.isE2ee) return NextResponse.json({ error: "e2ee send not supported in Plan A" }, { status: 400 });

  // double-check live block state between the two users
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    if (await isBlockedBetween(user.id, p)) return NextResponse.json({ error: "blocked" }, { status: 403 });
  }

  const msg = await insertDmMessage({ conversationId: id, senderType: "user", senderId: user.id, text: parsed.data.text, replyToMessageId: parsed.data.replyToMessageId ?? null });

  // fan out via the ws relay: emit to each participant's user room
  const allParticipants = [user.id, ...peers];
  await redis.publish(REDIS_CHANNELS.DM_MESSAGE_NEW, JSON.stringify({ conversationId: id, message: msg, userIds: allParticipants }));
  return NextResponse.json({ message: msg }, { status: 201 });
}
```

- [ ] **Step 2: Typecheck + manual verify**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.
Manual (after a conversation exists): POST a message via curl → `201` with `{message:{...}}`; GET → `{messages:[...]}` with the text round-tripped. Confirm the row is at-rest-encrypted: query `select content_ciphertext from dm_messages limit 1` shows bytes, not plaintext.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/api/dm/[id]/messages/route.ts"
git commit -m "feat(dm): messages history + send route with ws fan-out"
```

---

## Task 7: API — accept / block / read

**Files:**
- Create: `apps/web/app/api/dm/[id]/accept/route.ts`
- Create: `apps/web/app/api/dm/[id]/block/route.ts`
- Create: `apps/web/app/api/dm/[id]/read/route.ts`

- [ ] **Step 1: accept**

Create `apps/web/app/api/dm/[id]/accept/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant } from "@/lib/dm";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // only the recipient (non-initiator) accepts; initiator accept is a no-op
  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conv.state === "pending" && conv.initiatorId !== user.id) {
    await db.update(dmConversations).set({ state: "accepted" }).where(eq(dmConversations.id, id));
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: block**

Create `apps/web/app/api/dm/[id]/block/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { dmConversations } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant, recipientUserIds } from "@/lib/dm";
import { dmBlocks } from "@legends/db/schema";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const peers = await recipientUserIds(id, user.id);
  for (const p of peers) {
    await db.insert(dmBlocks).values({ blockerUserId: user.id, blockedUserId: p }).onConflictDoNothing();
  }
  await db.update(dmConversations).set({ state: "blocked" }).where(eq(dmConversations.id, id));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: read**

Create `apps/web/app/api/dm/[id]/read/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant } from "@/lib/dm";

const schema = z.object({ lastReadMessageId: z.string() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await assertParticipant(id, user.id);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  await db
    .update(dmParticipants)
    .set({ lastReadMessageId: BigInt(parsed.data.lastReadMessageId) })
    .where(and(eq(dmParticipants.conversationId, id), eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, user.id)));
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

```bash
git add "apps/web/app/api/dm/[id]/accept/route.ts" "apps/web/app/api/dm/[id]/block/route.ts" "apps/web/app/api/dm/[id]/read/route.ts"
git commit -m "feat(dm): accept / block / read routes"
```

---

## Task 8: ws relay for DM events

**Files:**
- Modify: `apps/ws/src/index.ts`

- [ ] **Step 1: Subscribe to the DM channel**

In `apps/ws/src/index.ts`, find the `subClient.subscribe(...)` call (the list of `REDIS_CHANNELS.*`) and add `REDIS_CHANNELS.DM_MESSAGE_NEW,` to the argument list (before the error callback).

- [ ] **Step 2: Relay DM messages to participant user rooms**

In the `subClient.on("message", (channel, message) => { ... })` handler, add a new branch alongside the existing `else if (channel === REDIS_CHANNELS.BOT_MESSAGE_NEW)` branches:

```ts
} else if (channel === REDIS_CHANNELS.DM_MESSAGE_NEW) {
  const { message: msg, userIds } = JSON.parse(message) as {
    conversationId: string;
    message: { id: string; conversationId: string; senderId: string; text: string; createdAt: string; senderType: string };
    userIds: string[];
  };
  for (const uid of userIds) {
    io.to(`user:${uid}`).emit(WS_EVENTS.DM_NEW, msg);
  }
```

(Place it before the final `} else if (channel === REDIS_CHANNELS.SYMBOLS_UPDATE)` branch or anywhere in the chain; keep brace balance.)

Rationale: participants are already auto-joined to their `user:<id>` room on connect, so no DM-specific join handshake is needed in Plan A. (A dedicated `dm:<id>` room is deferred; per-user emit is sufficient for 1:1.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @legends/ws typecheck`
Expected: no errors. (`WS_EVENTS.DM_NEW` and `REDIS_CHANNELS.DM_MESSAGE_NEW` resolve from `@legends/shared` added in Task 2.)

- [ ] **Step 4: Manual verify (two browser sessions)**

Start `pnpm --filter @legends/ws dev` and `pnpm --filter @legends/web dev`. With two logged-in users, POST a DM message as user A (curl or UI) and confirm user B's connected socket receives a `dm:new` event (observe via the UI in Task 9, or temporarily log `socket.on("dm:new")` in the browser console).

- [ ] **Step 5: Commit**

```bash
git add apps/ws/src/index.ts
git commit -m "feat(dm): ws relay of DM messages to participant rooms"
```

---

## Task 9: DM client UI (`/dm` page + `DmClient` + socket hook)

**Files:**
- Create: `apps/web/hooks/useDmSocket.ts`
- Create: `apps/web/components/DmClient.tsx`
- Create: `apps/web/app/dm/page.tsx`

- [ ] **Step 1: Socket hook**

Create `apps/web/hooks/useDmSocket.ts`. Mirror however the app already obtains its socket.io client (search for an existing `io(`/`getSocket(` usage in `apps/web` — e.g. in `TopicView.tsx` — and reuse that singleton/util rather than creating a second connection). Minimal shape:

```ts
"use client";
import { useEffect } from "react";
import { WS_EVENTS } from "@legends/shared";
import { getSocket } from "@/lib/socket"; // reuse existing socket util; adjust import to the real one

export type DmIncoming = { id: string; conversationId: string; senderId: string; senderType: string; text: string; createdAt: string };

export function useDmSocket(onMessage: (m: DmIncoming) => void) {
  useEffect(() => {
    const socket = getSocket();
    const handler = (m: DmIncoming) => onMessage(m);
    socket.on(WS_EVENTS.DM_NEW, handler);
    return () => { socket.off(WS_EVENTS.DM_NEW, handler); };
  }, [onMessage]);
}
```

If there is NO shared socket util (the socket is created inline in `TopicView`), extract the connection into `apps/web/lib/socket.ts` as a singleton `getSocket()` first, and update `TopicView` to use it. Quote/confirm the existing connection options (path `/socket.io`, `withCredentials: true`) when extracting.

- [ ] **Step 2: DmClient component**

Create `apps/web/components/DmClient.tsx` (`"use client"`). It renders: a left list (accepted conversations + a Requests section), a new-DM search box, and a thread pane with a composer. Uses `apiFetch` and the theme tokens.

```tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import { cn } from "@/lib/cn";
import { useDmSocket, type DmIncoming } from "@/hooks/useDmSocket";

type Conversation = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};
type Message = { id: string; conversationId: string; senderType: string; senderId: string; text: string; createdAt: string };
type SearchHit = { id: string; displayName: string; avatarUrl: string | null };

export function DmClient({ initialConversations, currentUserId }: { initialConversations: Conversation[]; currentUserId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const accepted = conversations.filter((c) => c.state === "accepted");
  const requests = conversations.filter((c) => c.state === "pending" && c.incoming);

  const refreshList = useCallback(async () => {
    const r = await apiFetch("/api/dm");
    if (r.ok) { const d = (await r.json()) as { conversations: Conversation[] }; setConversations(d.conversations); }
  }, []);

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    const r = await apiFetch(`/api/dm/${id}/messages`);
    if (r.ok) { const d = (await r.json()) as { messages: Message[] }; setMessages(d.messages); }
  }, []);

  useDmSocket(useCallback((m: DmIncoming) => {
    if (m.conversationId === activeId) setMessages((prev) => [...prev, m]);
    refreshList();
  }, [activeId, refreshList]));

  useEffect(() => { endRef.current?.scrollIntoView(); }, [messages]);

  // debounce search
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const r = await apiFetch(`/api/dm/search?q=${encodeURIComponent(query.trim())}`);
      if (r.ok) setHits((await r.json()) as SearchHit[]);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function startDm(peerId: string) {
    const r = await apiFetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerType: "user", peerId }) });
    if (!r.ok) return;
    const d = (await r.json()) as { id: string };
    setQuery(""); setHits([]);
    await refreshList();
    await openThread(d.id);
  }

  async function send() {
    if (!activeId || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const r = await apiFetch(`/api/dm/${activeId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (r.ok) { const d = (await r.json()) as { message: Message }; setMessages((prev) => [...prev, d.message]); }
  }

  async function accept(id: string) {
    await apiFetch(`/api/dm/${id}/accept`, { method: "POST" });
    await refreshList();
    await openThread(id);
  }

  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 border-r border-border bg-panel p-3 space-y-3 overflow-y-auto">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people…"
          className="w-full rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted"
        />
        {hits.length > 0 && (
          <div className="rounded-lg border border-border bg-panel2">
            {hits.map((h) => (
              <button key={h.id} onClick={() => startDm(h.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel">
                {h.displayName}
              </button>
            ))}
          </div>
        )}
        {requests.length > 0 && (
          <div>
            <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted">Requests</p>
            {requests.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-panel2">
                <span>{c.peer?.displayName ?? "Unknown"}</span>
                <button onClick={() => accept(c.id)} className="rounded bg-accent px-2 py-1 text-xs font-medium text-white">Accept</button>
              </div>
            ))}
          </div>
        )}
        <div>
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-widest text-muted">Direct Messages</p>
          {accepted.map((c) => (
            <button key={c.id} onClick={() => openThread(c.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-panel2", activeId === c.id && "bg-panel2")}>
              {c.peer?.displayName ?? "Unknown"}
            </button>
          ))}
          {accepted.length === 0 && <p className="px-3 py-2 text-xs text-muted">No conversations yet.</p>}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={cn("max-w-[70%] rounded-xl px-3 py-2 text-sm", m.senderId === currentUserId ? "ml-auto bg-accent text-white" : "bg-panel2 text-text")}>
                  {m.text}
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <div className="border-t border-border p-3">
              <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex gap-2">
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" className="flex-1 rounded-lg bg-panel2 px-3 py-2 text-sm outline-none placeholder:text-muted" />
                <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!draft.trim()}>Send</button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Select a conversation or search for someone.</div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Server page**

Create `apps/web/app/dm/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listConversations } from "@/lib/dm";
import { DmClient } from "@/components/DmClient";

export const dynamic = "force-dynamic";

export default async function DmPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const conversations = await listConversations(user.id);
  return (
    <main className="h-[100dvh]">
      <DmClient initialConversations={conversations} currentUserId={user.id} />
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors. (If `getSocket`/`@/lib/socket` did not exist and you extracted it, ensure `TopicView` still typechecks.)

- [ ] **Step 5: Manual browser verify (golden path + edges)**

With two users (two browsers/profiles), both logged in, `pnpm --filter @legends/web dev` + `pnpm --filter @legends/ws dev`:
1. User A → `/dm` → search User B → click → conversation opens.
2. A sends "hello" → appears in A's thread.
3. B → `/dm` → "hello" appears under **Requests** → B clicks Accept → thread opens showing "hello".
4. B replies → A sees it arrive live (via `dm:new`).
5. Edge: A opens the same DM again → no duplicate conversation (idempotent).
6. Edge: B blocks A (wire a block button if testing; or curl `/block`) → A's send returns 403.
7. Refresh both pages → history persists and renders.

- [ ] **Step 6: Commit**

```bash
git add apps/web/hooks/useDmSocket.ts apps/web/components/DmClient.tsx apps/web/app/dm/page.tsx
git commit -m "feat(dm): DM client UI (list, requests, thread, search) + socket hook"
```

---

## Task 10: Sidebar entry

**Files:**
- Modify: `apps/web/components/AppSidebar.tsx`

- [ ] **Step 1: Add a Direct Messages link to the chat sidebar**

DMs are a user-facing feature, so add the link to the chat-variant sidebar (the `{children}`/topics area used when `variant="chat"`), NOT `AdminNav`. Find where the chat sidebar renders its top-level nav (the topics list / home link) and add, using the existing `NavLink`/`Link` pattern + a lucide icon (`MessageCircle`):

```tsx
<Link href="/dm" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2">
  <MessageCircle className="h-4 w-4" /> Direct Messages
</Link>
```

Add `MessageCircle` to the existing `lucide-react` import line in `AppSidebar.tsx`. (The "Bots" tab is added in Plan C, where bot DMs exist; do not add it now.)

- [ ] **Step 2: Typecheck + manual verify + commit**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors. Manual: the chat sidebar shows "Direct Messages"; clicking navigates to `/dm`.

```bash
git add apps/web/components/AppSidebar.tsx
git commit -m "feat(dm): sidebar Direct Messages entry"
```

---

## Self-review checklist (run before declaring Plan A done)

- [ ] `pnpm -r typecheck` passes across all packages.
- [ ] `pnpm --filter @legends/db test:run` passes (`buildDmKey`).
- [ ] `pnpm db:migrate` applied cleanly on a fresh DB; the four `dm_*` tables exist.
- [ ] Smoke script passes.
- [ ] Manual two-user golden path (Task 9 Step 5) verified, including request/accept, live delivery, idempotent open, block, and history persistence.
- [ ] Spec coverage: data model (Task 1), discovery (Task 5), request/accept (Tasks 4/7), send/receive + at-rest encryption (Tasks 3/6/8), sidebar (Task 10). E2EE columns present but unused (deferred to Plan B); bots out of scope (Plan C). No topic/messages/e2eeSenderKeys files modified.

---

## Deferred to later plans (do NOT implement here)

- **Plan B (E2EE):** `dm_sender_keys` table, `/api/dm/[id]/keys` distribute/fetch, E2EE thread client (reuse `lib/e2ee.ts` + `E2EESetup`/`E2EEKeyWarning`), `isE2ee` selectable at creation, E2EE-blind push previews.
- **Plan C (plaintext bot DMs):** `bots.dmEnabled`, bot-API `conversationId` addressing + `dm_message` update type, SDK `on("dm_message")` + DM send, bot delivery producer keyed on `dm_participants`, "Bots" sidebar tab, including bots in `/api/dm/search`.
- Push notifications for DMs (plaintext preview), unread badges in the sidebar, message edit/delete UI, typing indicators, disappearing messages.
