# Hashtag Tracking & Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `#hashtag` and `$symbol` tags from messages, show a live tag cloud per topic, enable click-to-filter messages within the chat panel, and provide an admin CRUD for `$symbol` definitions.

**Architecture:** Tags are extracted client-side at send time and stored in a `text[]` column on `messages` with a GIN index. A `symbols` table holds admin-defined `$tickers`. WS broadcasts `HASHTAG_CLOUD_UPDATE` deltas on each new tagged message. A React context provides click-to-filter plumbing throughout the message renderer.

**Tech Stack:** PostgreSQL (Drizzle ORM), Socket.IO, Next.js App Router, Tiptap, React context, Redis pub/sub.

---

## File Map

| File | Action |
|------|--------|
| `packages/db/src/schema.ts` | Add `hashtags` column + `symbols` table |
| `packages/db/src/migrations/0029_hashtags_symbols.sql` | Migration SQL |
| `packages/db/src/migrations/meta/_journal.json` | Add journal entry |
| `packages/shared/src/events.ts` | Add `HASHTAG_CLOUD_UPDATE`, `SYMBOLS_UPDATE` to WS_EVENTS + REDIS_CHANNELS |
| `packages/shared/src/zod.ts` | Add `hashtags` field to `sendMessageSchema` |
| `apps/ws/src/messages.ts` | Accept + store `hashtags` in `insertMessage` |
| `apps/ws/src/index.ts` | Emit `HASHTAG_CLOUD_UPDATE`; handle `SYMBOLS_UPDATE` Redis channel |
| `apps/web/app/api/symbols/route.ts` | `GET /api/symbols` |
| `apps/web/app/api/topics/[id]/hashtags/route.ts` | `GET /api/topics/[id]/hashtags` |
| `apps/web/app/api/topics/[id]/messages/route.ts` | Add `?hashtag=` branch |
| `apps/web/app/api/admin/symbols/route.ts` | `GET`, `POST` |
| `apps/web/app/api/admin/symbols/[id]/route.ts` | `PUT`, `DELETE` |
| `apps/web/contexts/SymbolsContext.tsx` | Client context + provider for symbols list |
| `apps/web/contexts/HashtagClickContext.tsx` | Client context for click-to-filter plumbing |
| `apps/web/hooks/useTopicHashtags.ts` | Fetch + live-update tag cloud for a topic |
| `apps/web/app/layout.tsx` | Wrap children in `SymbolsProvider` |
| `apps/web/components/MarkdownContent.tsx` | `$symbol` spans + click delegation |
| `apps/web/components/RichTextEditor.tsx` | `#`/`$` autocomplete suggestion extension |
| `apps/web/components/TopicInfoModal.tsx` | Tag cloud section |
| `apps/web/components/TopicView.tsx` | `hashtagFilter` state + filtered view + vendor card |
| `apps/web/components/AdminSymbolsPanel.tsx` | Admin CRUD panel component |
| `apps/web/app/admin/symbols/page.tsx` | Admin symbols page |
| `apps/web/components/AppSidebar.tsx` | Add Symbols nav link |

---

## Task 1: DB Schema + Migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0029_hashtags_symbols.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add `hashtags` column and `symbols` table to schema.ts**

In `packages/db/src/schema.ts`, after the `messages` table definition (around line 247), add:

```ts
// Inside the messages table columns object, after `deletedAt`:
hashtags: text("hashtags").array().default(sql`'{}'::text[]`),
```

And after all existing table definitions at the bottom of the file, add:

```ts
export const symbols = pgTable("symbols", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  linkedUserId: uuid("linked_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Create migration SQL**

Create `packages/db/src/migrations/0029_hashtags_symbols.sql`:

```sql
ALTER TABLE "messages" ADD COLUMN "hashtags" text[] DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS "messages_hashtags_gin" ON "messages" USING GIN ("hashtags");

CREATE TABLE IF NOT EXISTS "symbols" (
  "id" serial PRIMARY KEY NOT NULL,
  "symbol" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "linked_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

UPDATE "messages"
SET "hashtags" = ARRAY(
  SELECT DISTINCT lower(m[1])
  FROM regexp_matches("search_text", '(#[a-zA-Z]\w*)', 'g') AS m
)
WHERE "search_text" IS NOT NULL
  AND "search_text" <> ''
  AND "deleted_at" IS NULL
  AND "search_text" ~ '#[a-zA-Z]';
```

- [ ] **Step 3: Update migration journal**

In `packages/db/src/migrations/meta/_journal.json`, add to the `entries` array:

```json
{
  "idx": 29,
  "version": "7",
  "when": 1747000000000,
  "tag": "0029_hashtags_symbols",
  "breakpoints": true
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/mrlucifer/repos/legends-chat
npx tsc --noEmit -p packages/db/tsconfig.json 2>&1
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/0029_hashtags_symbols.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add messages.hashtags column and symbols table"
```

---

## Task 2: Shared Events + Schema

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/zod.ts`

- [ ] **Step 1: Add WS events and Redis channel**

In `packages/shared/src/events.ts`, update `WS_EVENTS` and `REDIS_CHANNELS`:

```ts
export const WS_EVENTS = {
  // ... all existing entries ...
  HASHTAG_CLOUD_UPDATE: "hashtag:cloud:update",
  SYMBOLS_UPDATE: "symbols:update",
} as const;

export const REDIS_CHANNELS = {
  // ... all existing entries ...
  SYMBOLS_UPDATE: "legends:symbols:update",
} as const;
```

- [ ] **Step 2: Add hashtags to sendMessageSchema**

In `packages/shared/src/zod.ts`, update `sendMessageSchema`:

```ts
export const sendMessageSchema = z.object({
  topicId: z.string().uuid(),
  content: messageContentSchema,
  hashtags: z
    .array(z.string().regex(/^[#$][a-zA-Z]\w*$/))
    .max(20)
    .optional(),
});
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/zod.ts
git commit -m "feat(shared): add HASHTAG_CLOUD_UPDATE, SYMBOLS_UPDATE events and hashtags schema field"
```

---

## Task 3: WS – Store Hashtags + Emit HASHTAG_CLOUD_UPDATE

**Files:**
- Modify: `apps/ws/src/messages.ts`
- Modify: `apps/ws/src/index.ts`

- [ ] **Step 1: Update `insertMessage` to accept and store hashtags**

In `apps/ws/src/messages.ts`, update the `insertMessage` args interface and body:

```ts
export async function insertMessage(args: {
  topicId: string;
  senderUserId: string | null;
  botId?: string | null;
  text: string;
  attachments?: MessageAttachment[];
  replyToMessageId?: string | null;
  searchText?: string;
  hashtags?: string[];
}): Promise<InsertedMessage> {
  const key = await currentDataKey();
  const aad = new TextEncoder().encode(args.topicId);
  const encoded = encodeContent(args.text, args.attachments);
  const { ciphertext, nonce } = encryptMessage(key.data, encoded, aad);
  const [row] = await db
    .insert(messages)
    .values({
      topicId: args.topicId,
      senderUserId: args.senderUserId,
      botId: args.botId ?? null,
      replyToMessageId: args.replyToMessageId ? BigInt(args.replyToMessageId) : null,
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      keyId: key.id,
      hashtags: args.hashtags && args.hashtags.length > 0 ? args.hashtags : [],
    })
    .returning();

  // ... rest of function unchanged ...
```

- [ ] **Step 2: Emit HASHTAG_CLOUD_UPDATE in MESSAGE_SEND handler**

In `apps/ws/src/index.ts`, in the `MESSAGE_SEND` socket handler, after the existing `sidebarPayload` broadcast (around line 183), add:

```ts
// After the sidebarPayload getTopicMemberUserIds block:
const incomingHashtags = parsed.hashtags ?? [];
const validHashtags = incomingHashtags
  .filter((t) => /^[#$][a-zA-Z]\w*$/.test(t))
  .slice(0, 20);

const msg = await insertMessage({
  topicId: parsed.topicId,
  senderUserId: user.sub,
  text: parsed.content.text,
  attachments: parsed.content.attachments as import("./messages").MessageAttachment[] | undefined,
  replyToMessageId: parsed.content.replyToMessageId ?? null,
  searchText: isE2ee ? undefined : parsed.content.text,
  hashtags: validHashtags,
});
```

Note: replace the existing `insertMessage` call in the `MESSAGE_SEND` handler to pass `hashtags: validHashtags`. Then after the sidebar broadcast block, add:

```ts
if (validHashtags.length > 0) {
  io.to(`topic:${parsed.topicId}`).emit(WS_EVENTS.HASHTAG_CLOUD_UPDATE, {
    topicId: parsed.topicId,
    tags: validHashtags,
  });
}
```

- [ ] **Step 3: Handle SYMBOLS_UPDATE Redis channel**

In `apps/ws/src/index.ts`, in the Redis `subClient.on("message", ...)` handler, add a new `else if` branch alongside the existing ones:

```ts
} else if (channel === REDIS_CHANNELS.SYMBOLS_UPDATE) {
  io.emit(WS_EVENTS.SYMBOLS_UPDATE, {});
}
```

Also add `REDIS_CHANNELS.SYMBOLS_UPDATE` to the `subClient.subscribe(...)` call at the top of the file.

- [ ] **Step 4: Type-check WS**

```bash
npx tsc --noEmit -p apps/ws/tsconfig.json 2>&1
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/ws/src/messages.ts apps/ws/src/index.ts
git commit -m "feat(ws): store hashtags on insert, emit HASHTAG_CLOUD_UPDATE and SYMBOLS_UPDATE"
```

---

## Task 4: Admin Symbols API

**Files:**
- Create: `apps/web/app/api/admin/symbols/route.ts`
- Create: `apps/web/app/api/admin/symbols/[id]/route.ts`

- [ ] **Step 1: Create `apps/web/app/api/admin/symbols/route.ts`**

```ts
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS, REDIS_CHANNELS } from "@legends/shared";
import { symbols, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

const bodySchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[a-zA-Z]\w*$/, "Letters and digits only, no $ prefix"),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  linkedUserId: z.string().uuid().nullable().optional(),
});

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await db
    .select({
      id: symbols.id,
      symbol: symbols.symbol,
      name: symbols.name,
      description: symbols.description,
      linkedUserId: symbols.linkedUserId,
      linkedUserDisplayName: users.displayName,
      linkedUserAvatarUrl: users.avatarUrl,
      createdAt: symbols.createdAt,
    })
    .from(symbols)
    .leftJoin(users, eq(symbols.linkedUserId, users.id))
    .orderBy(asc(symbols.symbol));
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const [row] = await db
    .insert(symbols)
    .values({
      symbol: body.data.symbol.toLowerCase(),
      name: body.data.name,
      description: body.data.description ?? null,
      linkedUserId: body.data.linkedUserId ?? null,
    })
    .returning();

  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json(row, { status: 201 });
}
```

- [ ] **Step 2: Create `apps/web/app/api/admin/symbols/[id]/route.ts`**

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS, REDIS_CHANNELS } from "@legends/shared";
import { symbols } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

const bodySchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[a-zA-Z]\w*$/).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  linkedUserId: z.string().uuid().nullable().optional(),
});

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) return null;
  return user;
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = bodySchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });

  const updates: Partial<typeof symbols.$inferInsert> = {};
  if (body.data.symbol !== undefined) updates.symbol = body.data.symbol.toLowerCase();
  if (body.data.name !== undefined) updates.name = body.data.name;
  if ("description" in body.data) updates.description = body.data.description ?? null;
  if ("linkedUserId" in body.data) updates.linkedUserId = body.data.linkedUserId ?? null;

  const [row] = await db
    .update(symbols)
    .set(updates)
    .where(eq(symbols.id, numId))
    .returning();

  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json(row);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  await db.delete(symbols).where(eq(symbols.id, numId));
  await redis.publish(REDIS_CHANNELS.SYMBOLS_UPDATE, "{}");
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors related to symbols routes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/admin/symbols/
git commit -m "feat(api): admin symbols CRUD endpoints"
```

---

## Task 5: Public Symbols API + Topic Hashtags API + Hashtag Filter

**Files:**
- Create: `apps/web/app/api/symbols/route.ts`
- Create: `apps/web/app/api/topics/[id]/hashtags/route.ts`
- Modify: `apps/web/app/api/topics/[id]/messages/route.ts`

- [ ] **Step 1: Create `apps/web/app/api/symbols/route.ts`**

```ts
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { symbols, users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: symbols.id,
      symbol: symbols.symbol,
      name: symbols.name,
      description: symbols.description,
      linkedUserId: symbols.linkedUserId,
      linkedUserDisplayName: users.displayName,
      linkedUserAvatarUrl: users.avatarUrl,
    })
    .from(symbols)
    .leftJoin(users, eq(symbols.linkedUserId, users.id))
    .orderBy(asc(symbols.symbol));

  return NextResponse.json(rows);
}
```

- [ ] **Step 2: Create `apps/web/app/api/topics/[id]/hashtags/route.ts`**

```ts
import { NextResponse } from "next/server";
import { and, isNull, eq, sql } from "drizzle-orm";
import { messages, topicMembers } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id: topicId } = await params;

  // Verify membership
  const [member] = await db
    .select({ userId: topicMembers.userId })
    .from(topicMembers)
    .where(
      and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, user.id),
      ),
    )
    .limit(1);
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const rows = await db.execute<{ tag: string; count: string }>(
    sql`
      SELECT tag, COUNT(*)::text AS count
      FROM messages, unnest(hashtags) AS tag
      WHERE topic_id = ${topicId}
        AND deleted_at IS NULL
        AND array_length(hashtags, 1) > 0
      GROUP BY tag
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `,
  );

  return NextResponse.json(
    rows.rows.map((r) => ({ tag: r.tag, count: Number(r.count) })),
  );
}
```

- [ ] **Step 3: Add `?hashtag=` branch to `apps/web/app/api/topics/[id]/messages/route.ts`**

Read the current file first. Then add a new branch after the existing `replyTo` check:

```ts
// Add after the `const replyTo = searchParams.get("replyTo");` line:
const hashtagFilter = searchParams.get("hashtag");

if (hashtagFilter) {
  // Validate format
  if (!/^[#$][a-zA-Z]\w*$/.test(hashtagFilter)) {
    return NextResponse.json({ error: "invalid hashtag" }, { status: 400 });
  }

  const topic = await db
    .select({ isE2ee: topics.isE2ee })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)
    .then((r) => r[0]);

  if (!topic || topic.isE2ee) return NextResponse.json([]);

  const rows = await db
    .select({
      id: messages.id,
      topicId: messages.topicId,
      senderUserId: messages.senderUserId,
      senderDisplayName: users.displayName,
      senderAvatarUrl: users.avatarUrl,
      contentCiphertext: messages.contentCiphertext,
      contentNonce: messages.contentNonce,
      keyId: messages.keyId,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      replyToMessageId: messages.replyToMessageId,
    })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(
      and(
        eq(messages.topicId, topicId),
        isNull(messages.deletedAt),
        sql`${messages.hashtags} @> ARRAY[${hashtagFilter}]::text[]`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50);

  const decrypted = await Promise.all(
    rows.map(async (r) => {
      try {
        const key = await getKey(r.keyId);
        const aad = new TextEncoder().encode(topicId);
        const raw = decryptMessage(key, r.contentCiphertext, r.contentNonce, aad);
        const parsed = JSON.parse(raw) as { v?: number; t?: string; a?: unknown[] };
        const text = parsed.v === 1 ? (parsed.t ?? "") : raw;
        return {
          id: r.id.toString(),
          topicId: r.topicId,
          senderUserId: r.senderUserId,
          senderDisplayName: r.senderDisplayName ?? null,
          senderAvatarUrl: r.senderAvatarUrl ?? null,
          text,
          attachments: parsed.v === 1 ? (parsed.a ?? []) : [],
          createdAt: r.createdAt,
          editedAt: r.editedAt ?? null,
          replyToMessageId: r.replyToMessageId?.toString() ?? null,
        };
      } catch {
        return null;
      }
    }),
  );

  return NextResponse.json(decrypted.filter(Boolean));
}
```

Note: add `desc` to the drizzle import at the top of that file if not already present, and add `topics` to the schema import.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/symbols/ apps/web/app/api/topics/
git commit -m "feat(api): symbols public endpoint, topic hashtags, and hashtag message filter"
```

---

## Task 6: SymbolsContext + HashtagClickContext

**Files:**
- Create: `apps/web/contexts/SymbolsContext.tsx`
- Create: `apps/web/contexts/HashtagClickContext.tsx`
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Create `apps/web/contexts/SymbolsContext.tsx`**

```tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export interface AppSymbol {
  id: number;
  symbol: string;
  name: string;
  description: string | null;
  linkedUserId: string | null;
  linkedUserDisplayName: string | null;
  linkedUserAvatarUrl: string | null;
}

interface SymbolsContextValue {
  symbols: AppSymbol[];
  isKnownSymbol: (sym: string) => boolean;
  getSymbol: (sym: string) => AppSymbol | undefined;
  refetch: () => void;
}

const SymbolsContext = createContext<SymbolsContextValue>({
  symbols: [],
  isKnownSymbol: () => false,
  getSymbol: () => undefined,
  refetch: () => undefined,
});

export function SymbolsProvider({ children }: { children: React.ReactNode }) {
  const [symbols, setSymbols] = useState<AppSymbol[]>([]);

  const load = useCallback(() => {
    fetch("/api/symbols")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AppSymbol[]) => setSymbols(data))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    // Refresh on window focus (catches admin changes from another tab)
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const isKnownSymbol = useCallback(
    (sym: string) => symbols.some((s) => s.symbol === sym.toLowerCase()),
    [symbols],
  );

  const getSymbol = useCallback(
    (sym: string) => symbols.find((s) => s.symbol === sym.toLowerCase()),
    [symbols],
  );

  return (
    <SymbolsContext.Provider value={{ symbols, isKnownSymbol, getSymbol, refetch: load }}>
      {children}
    </SymbolsContext.Provider>
  );
}

export function useSymbols() {
  return useContext(SymbolsContext);
}
```

- [ ] **Step 2: Create `apps/web/contexts/HashtagClickContext.tsx`**

```tsx
"use client";

import { createContext, useContext } from "react";

interface HashtagClickContextValue {
  onHashtagClick: (tag: string) => void;
}

export const HashtagClickContext = createContext<HashtagClickContextValue>({
  onHashtagClick: () => undefined,
});

export function useHashtagClick() {
  return useContext(HashtagClickContext);
}
```

- [ ] **Step 3: Wire `SymbolsProvider` into `apps/web/app/layout.tsx`**

In the layout file, add the import and wrap `{children}` in `<SymbolsProvider>`:

```tsx
// Add import near other imports:
import { SymbolsProvider } from "@/contexts/SymbolsContext";

// In the body, replace:
//   <body className="bg-bg text-text"><PushSetup />{children}</body>
// with:
<body className="bg-bg text-text">
  <PushSetup />
  <SymbolsProvider>{children}</SymbolsProvider>
</body>
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/contexts/ apps/web/app/layout.tsx
git commit -m "feat(web): add SymbolsContext and HashtagClickContext"
```

---

## Task 7: useTopicHashtags Hook

**Files:**
- Create: `apps/web/hooks/useTopicHashtags.ts`

- [ ] **Step 1: Create `apps/web/hooks/useTopicHashtags.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { WS_EVENTS } from "@legends/shared";

export interface HashtagCloudEntry {
  tag: string;
  count: number;
}

export function useTopicHashtags(topicId: string, socket: Socket | null) {
  const [tags, setTags] = useState<HashtagCloudEntry[]>([]);

  const load = useCallback(() => {
    fetch(`/api/topics/${topicId}/hashtags`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: HashtagCloudEntry[]) => setTags(data))
      .catch(() => undefined);
  }, [topicId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const handler = (payload: { topicId: string; tags: string[] }) => {
      if (payload.topicId !== topicId) return;
      setTags((prev) => {
        const map = new Map(prev.map((e) => [e.tag, e.count]));
        for (const t of payload.tags) {
          map.set(t, (map.get(t) ?? 0) + 1);
        }
        return Array.from(map.entries())
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
      });
    };
    socket.on(WS_EVENTS.HASHTAG_CLOUD_UPDATE, handler);
    return () => { socket.off(WS_EVENTS.HASHTAG_CLOUD_UPDATE, handler); };
  }, [socket, topicId]);

  return { tags, reload: load };
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/hooks/useTopicHashtags.ts
git commit -m "feat(web): useTopicHashtags hook with live WS delta updates"
```

---

## Task 8: MarkdownContent — $symbol Support + Click Delegation

**Files:**
- Modify: `apps/web/components/MarkdownContent.tsx`

- [ ] **Step 1: Update `MarkdownContent.tsx`**

Replace the entire file with:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { marked } from "marked";
import { useSymbols } from "@/contexts/SymbolsContext";
import { useHashtagClick } from "@/contexts/HashtagClickContext";

marked.setOptions({ gfm: true, breaks: true });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeTiptapMarkdown(s: string): string {
  return s.replace(/\\([*_~`#|>\[\]()\\])/g, "$1");
}

function preprocessMentions(content: string): string {
  return content.replace(/\[@([^\]]*)\]/g, (_, attrs: string) => {
    const labelMatch = attrs.match(/label="([^"]*)"/);
    const label = escapeHtml(labelMatch?.[1] ?? "Unknown");
    return `<span class="mention-tag" data-mention="${label}">@${label}</span>`;
  });
}

function applyTags(root: HTMLElement, isKnownSymbol: (s: string) => boolean) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === "code" || tag === "pre" || tag === "a") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);

  for (const textNode of nodes) {
    const val = textNode.nodeValue ?? "";
    if (!/#[a-zA-Z]\w*|\$[a-zA-Z]\w*/.test(val)) continue;
    const frag = document.createDocumentFragment();
    const parts = val.split(/(#[a-zA-Z]\w*|\$[a-zA-Z]\w*)/g);
    for (const part of parts) {
      if (/^#[a-zA-Z]\w*$/.test(part)) {
        const span = document.createElement("span");
        span.className = "hashtag-tag cursor-pointer";
        span.setAttribute("data-tag", part);
        span.textContent = part;
        frag.appendChild(span);
      } else if (/^\$[a-zA-Z]\w*$/.test(part)) {
        const sym = part.slice(1).toLowerCase();
        if (isKnownSymbol(sym)) {
          const span = document.createElement("span");
          span.className = "symbol-tag cursor-pointer";
          span.setAttribute("data-tag", part);
          span.textContent = part;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(part));
        }
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

interface Props {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { isKnownSymbol } = useSymbols();
  const { onHashtagClick } = useHashtagClick();

  useEffect(() => {
    if (!ref.current) return;
    const preprocessed = preprocessMentions(unescapeTiptapMarkdown(content));
    const html = marked.parse(preprocessed) as string;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,form").forEach((el) => el.remove());
    doc.querySelectorAll("[onclick],[onerror],[onload],[onmouseover]").forEach((el) => {
      ["onclick", "onerror", "onload", "onmouseover"].forEach((attr) => el.removeAttribute(attr));
    });
    doc.querySelectorAll("a[href]").forEach((el) => {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    });
    ref.current.innerHTML = doc.body.innerHTML;
    applyTags(ref.current, isKnownSymbol);
  }, [content, isKnownSymbol]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest("[data-tag]") as HTMLElement | null;
      if (!target) return;
      const tag = target.getAttribute("data-tag");
      if (tag) onHashtagClick(tag);
    };
    el.addEventListener("click", handler);
    return () => el.removeEventListener("click", handler);
  }, [onHashtagClick]);

  return (
    <div
      ref={ref}
      className={`prose prose-sm prose-invert max-w-none ${className ?? ""}`}
    />
  );
}
```

- [ ] **Step 2: Add CSS for symbol-tag**

In `apps/web/app/globals.css`, add alongside the existing `.hashtag-tag` rule:

```css
.symbol-tag {
  color: var(--ch-accent, #f59e0b);
  font-weight: 600;
  font-family: ui-monospace, monospace;
}
.symbol-tag:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/MarkdownContent.tsx apps/web/app/globals.css
git commit -m "feat(web): MarkdownContent supports \$symbol tags and click delegation"
```

---

## Task 9: RichTextEditor — Hashtag + Symbol Autocomplete

**Files:**
- Modify: `apps/web/components/RichTextEditor.tsx`

- [ ] **Step 1: Add `topicTags` and `symbols` props + autocomplete suggestion builder**

Add new interfaces and a suggestion builder function. The editor's `Mention` extension supports multiple trigger chars — we need two separate `Mention` extensions for `#` and `$`.

Update the Props interface:

```ts
interface TagEntry { tag: string; count: number; }
interface AppSymbolEntry { symbol: string; name: string; avatarUrl: string | null; }

interface Props {
  value: string;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  compact?: boolean;
  enterSends?: boolean;
  disabled?: boolean;
  members?: MentionMember[];
  topicTags?: TagEntry[];
  symbols?: AppSymbolEntry[];
}
```

Add this function alongside `buildMentionSuggestion`:

```ts
function buildTagSuggestion(
  getItems: (query: string) => { id: string; label: string; sub?: string; avatarUrl?: string | null }[],
) {
  return {
    items: ({ query }: { query: string }) => getItems(query).slice(0, 8),
    render: () => {
      let el: HTMLDivElement | null = null;
      let selectedIndex = 0;
      let currentItems: { id: string; label: string; sub?: string; avatarUrl?: string | null }[] = [];
      let currentCommand: ((props: { id: string; label: string }) => void) | null = null;

      function renderItems() {
        if (!el) return;
        el.innerHTML = "";
        if (currentItems.length === 0) { el.style.display = "none"; return; }
        el.style.display = "";
        currentItems.forEach((item, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = [
            "w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition cursor-pointer",
            i === selectedIndex
              ? "bg-[color:var(--ch-panel2,#1e2130)] text-[color:var(--ch-text,#e8eaf2)]"
              : "text-[color:var(--ch-muted,#6b7280)] hover:bg-[color:var(--ch-panel2,#1e2130)] hover:text-[color:var(--ch-text,#e8eaf2)]",
          ].join(" ");
          if (item.avatarUrl) {
            const img = document.createElement("img");
            img.src = item.avatarUrl;
            img.className = "h-6 w-6 rounded-full object-cover shrink-0";
            btn.appendChild(img);
          }
          const labelEl = document.createElement("span");
          labelEl.textContent = item.label;
          btn.appendChild(labelEl);
          if (item.sub) {
            const sub = document.createElement("span");
            sub.className = "text-xs text-[color:var(--ch-muted,#6b7280)] ml-auto";
            sub.textContent = item.sub;
            btn.appendChild(sub);
          }
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            currentCommand?.({ id: item.id, label: item.label });
          });
          el!.appendChild(btn);
        });
      }

      function position(clientRect: (() => DOMRect | null) | null | undefined) {
        if (!el || !clientRect) return;
        const rect = clientRect();
        if (!rect) return;
        const vvh = window.visualViewport?.height ?? window.innerHeight;
        const vvy = window.visualViewport?.offsetTop ?? 0;
        const estimatedH = Math.min(currentItems.length * 44 + 8, 320);
        const spaceBelow = (vvy + vvh) - rect.bottom;
        const top = spaceBelow >= estimatedH
          ? rect.bottom + 4
          : Math.max(vvy + 4, rect.top - estimatedH - 4);
        el.style.top = `${top}px`;
        el.style.left = `${rect.left}px`;
        el.style.maxWidth = `${window.innerWidth - rect.left - 8}px`;
      }

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onStart(props: any) {
          currentItems = props.items;
          currentCommand = props.command;
          selectedIndex = 0;
          el = document.createElement("div");
          el.className = "fixed z-[9999] min-w-[180px] rounded-xl border border-[color:var(--ch-border,#2a2d3e)] bg-[color:var(--ch-panel,#141721)] shadow-2xl py-1 overflow-y-auto";
          el.style.maxHeight = "320px";
          document.body.appendChild(el);
          position(props.clientRect);
          renderItems();
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onUpdate(props: any) {
          currentItems = props.items;
          currentCommand = props.command;
          selectedIndex = 0;
          position(props.clientRect);
          renderItems();
        },
        onKeyDown({ event }: { event: KeyboardEvent }) {
          if (!currentItems.length) return false;
          if (event.key === "ArrowDown") { selectedIndex = (selectedIndex + 1) % currentItems.length; renderItems(); return true; }
          if (event.key === "ArrowUp") { selectedIndex = (selectedIndex - 1 + currentItems.length) % currentItems.length; renderItems(); return true; }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = currentItems[selectedIndex];
            if (item) currentCommand?.({ id: item.id, label: item.label });
            return true;
          }
          return false;
        },
        onExit() { el?.remove(); el = null; },
      };
    },
  };
}
```

- [ ] **Step 2: Add `topicTagsRef` and `symbolsRef`, add two new Mention extensions**

In the `RichTextEditor` component body, after `membersRef`:

```ts
const topicTagsRef = useRef<TagEntry[]>(topicTags ?? []);
useEffect(() => { topicTagsRef.current = topicTags ?? []; }, [topicTags]);

const symbolsRef = useRef<AppSymbolEntry[]>(symbols ?? []);
useEffect(() => { symbolsRef.current = symbols ?? []; }, [symbols]);
```

In `useEditor` extensions array, add alongside the existing `Mention.configure(...)`:

```ts
Mention.configure({
  HTMLAttributes: { class: "hashtag-tag" },
  suggestion: {
    char: "#",
    ...buildTagSuggestion((query) => {
      const q = query.toLowerCase();
      return (topicTagsRef.current ?? [])
        .filter((t) => t.tag.slice(1).includes(q))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map((t) => ({ id: t.tag, label: t.tag }));
    }),
  },
}),
Mention.configure({
  HTMLAttributes: { class: "symbol-tag" },
  suggestion: {
    char: "$",
    ...buildTagSuggestion((query) => {
      const q = query.toLowerCase();
      return (symbolsRef.current ?? [])
        .filter((s) => s.symbol.includes(q) || s.name.toLowerCase().includes(q))
        .map((s) => ({
          id: `$${s.symbol}`,
          label: `$${s.symbol}`,
          sub: s.name,
          avatarUrl: s.avatarUrl,
        }));
    }),
  },
}),
```

Note: Tiptap's `Mention` extension uses the `char` option to set the trigger character. Two separate instances handle `#` and `$` independently.

- [ ] **Step 3: Update component signature to accept new props**

```ts
export const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { value, onChange, onSubmit, placeholder, compact, enterSends, disabled, members, topicTags, symbols },
  ref,
) {
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/RichTextEditor.tsx
git commit -m "feat(web): RichTextEditor adds # and \$ autocomplete suggestions"
```

---

## Task 10: TopicInfoModal — Tag Cloud Section

**Files:**
- Modify: `apps/web/components/TopicInfoModal.tsx`

- [ ] **Step 1: Update `TopicInfoModal.tsx`**

Replace the entire file with:

```tsx
"use client";

import { X } from "lucide-react";
import { useTopicHashtags } from "@/hooks/useTopicHashtags";
import { useSymbols } from "@/contexts/SymbolsContext";
import type { Socket } from "socket.io-client";

interface Props {
  topic: {
    id: string;
    title: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    description: string | null;
  };
  socket: Socket | null;
  onClose: () => void;
  onHashtagFilter: (tag: string) => void;
}

export function TopicInfoModal({ topic, socket, onClose, onHashtagFilter }: Props) {
  const initials = topic.title.slice(0, 1).toUpperCase();
  const { tags } = useTopicHashtags(topic.id, socket);
  const { getSymbol } = useSymbols();

  function handleTagClick(tag: string) {
    onClose();
    onHashtagFilter(tag);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-panel shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-lg p-1.5 bg-black/40 text-white/80 hover:bg-black/60 transition"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Banner */}
        <div className="relative h-32 bg-panel2">
          {topic.bannerUrl ? (
            <img src={topic.bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-accent/30 to-accent2/20" />
          )}
        </div>

        {/* Icon */}
        <div className="px-5 pb-4">
          <div className="-mt-8 mb-3 h-16 w-16 rounded-2xl border-4 border-panel bg-panel2 flex items-center justify-center text-2xl font-bold overflow-hidden">
            {topic.iconUrl ? (
              <img src={topic.iconUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <h2 className="text-lg font-semibold">{topic.title}</h2>
          {topic.description && (
            <p className="mt-1 text-sm text-muted">{topic.description}</p>
          )}

          {/* Tag cloud */}
          {tags.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted uppercase tracking-wide">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map(({ tag }) => {
                  const isSymbol = tag.startsWith("$");
                  const sym = isSymbol ? getSymbol(tag.slice(1)) : null;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleTagClick(tag)}
                      className={[
                        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-mono transition",
                        isSymbol
                          ? "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                          : "bg-panel2 text-muted hover:bg-border hover:text-text",
                      ].join(" ")}
                    >
                      {sym?.linkedUserAvatarUrl && (
                        <img
                          src={sym.linkedUserAvatarUrl}
                          alt=""
                          className="h-3.5 w-3.5 rounded-full object-cover"
                        />
                      )}
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {tags.length === 0 && (
            <p className="mt-4 text-xs text-muted">No tags yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Fix TopicView call site**

`TopicInfoModal` now requires `id`, `socket`, and `onHashtagFilter` props. In `apps/web/components/TopicView.tsx`, find the `<TopicInfoModal>` usage and update:

```tsx
{showTopicInfo && (
  <TopicInfoModal
    topic={{
      id: topic.id,
      title: topic.title,
      iconUrl: topic.iconUrl ?? null,
      bannerUrl: topic.bannerUrl ?? null,
      description: topic.description ?? null,
    }}
    socket={socketRef.current}
    onClose={() => setShowTopicInfo(false)}
    onHashtagFilter={(tag) => {
      setShowTopicInfo(false);
      setHashtagFilter(tag);
    }}
  />
)}
```

Note: `setHashtagFilter` is added in Task 11.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors (will have errors about `setHashtagFilter` until Task 11 is done — that's OK at this stage).

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/TopicInfoModal.tsx
git commit -m "feat(web): TopicInfoModal shows live tag cloud with click-to-filter"
```

---

## Task 11: TopicView — Hashtag Filter Mode + Send Integration

**Files:**
- Modify: `apps/web/components/TopicView.tsx`

This is the largest task. Make targeted edits in order.

- [ ] **Step 1: Add new imports at top of `TopicView.tsx`**

```ts
import { HashtagClickContext } from "@/contexts/HashtagClickContext";
import { useSymbols } from "@/contexts/SymbolsContext";
import { useTopicHashtags } from "@/hooks/useTopicHashtags";
import type { HashtagCloudEntry } from "@/hooks/useTopicHashtags";
```

- [ ] **Step 2: Add `hashtagFilter` state and filtered messages state**

In the component body, alongside other `useState` declarations:

```ts
const [hashtagFilter, setHashtagFilter] = useState<string | null>(null);
const [filteredMessages, setFilteredMessages] = useState<Message[]>([]);
const [filteredLoading, setFilteredLoading] = useState(false);
```

- [ ] **Step 3: Add `useTopicHashtags` and `useSymbols` calls**

```ts
const { tags: topicTags } = useTopicHashtags(topic.id, socketRef.current);
const { symbols, refetch: refetchSymbols } = useSymbols();
```

- [ ] **Step 4: Listen for `SYMBOLS_UPDATE` WS event**

In the WS `useEffect` where other `socket.on(...)` calls are made, add:

```ts
socket.on(WS_EVENTS.SYMBOLS_UPDATE, () => {
  refetchSymbols();
});
```

- [ ] **Step 5: Add `useEffect` to fetch filtered messages when `hashtagFilter` changes**

```ts
useEffect(() => {
  if (!hashtagFilter) {
    setFilteredMessages([]);
    return;
  }
  setFilteredLoading(true);
  fetch(`/api/topics/${topic.id}/messages?hashtag=${encodeURIComponent(hashtagFilter)}`)
    .then((r) => (r.ok ? r.json() : []))
    .then((data: Message[]) => setFilteredMessages(data))
    .catch(() => setFilteredMessages([]))
    .finally(() => setFilteredLoading(false));
}, [hashtagFilter, topic.id]);
```

- [ ] **Step 6: Extract hashtags before emitting MESSAGE_SEND**

In the `send()` function, before the `socketRef.current?.emit(WS_EVENTS.MESSAGE_SEND, ...)` call, add:

```ts
// Extract hashtags client-side
const hashtags: string[] = [];
const hashRegex = /#([a-zA-Z]\w*)/g;
const symRegex = /\$([a-zA-Z]\w*)/g;
let m: RegExpExecArray | null;
while ((m = hashRegex.exec(text)) !== null) {
  const tag = `#${m[1].toLowerCase()}`;
  if (!hashtags.includes(tag)) hashtags.push(tag);
}
while ((m = symRegex.exec(text)) !== null) {
  const sym = m[1].toLowerCase();
  if (symbols.some((s) => s.symbol === sym)) {
    const tag = `$${sym}`;
    if (!hashtags.includes(tag)) hashtags.push(tag);
  }
}
```

Then add `hashtags: hashtags.length > 0 ? hashtags.slice(0, 20) : undefined` to the `emit` payload:

```ts
socketRef.current?.emit(
  WS_EVENTS.MESSAGE_SEND,
  {
    topicId: topic.id,
    content: {
      text: finalText,
      attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      replyToMessageId: replyingTo?.id,
    },
    hashtags: hashtags.length > 0 ? hashtags.slice(0, 20) : undefined,
  },
  ...
);
```

- [ ] **Step 7: Pass `topicTags` and `symbols` to `RichTextEditor`**

Find the `<RichTextEditor>` component in the JSX and add:

```tsx
topicTags={topicTags}
symbols={symbols.map((s) => ({
  symbol: s.symbol,
  name: s.name,
  avatarUrl: s.linkedUserAvatarUrl,
}))}
```

- [ ] **Step 8: Add filter banner, vendor card, and filtered message list to JSX**

After the existing `<header>` element and before the main message list, add:

```tsx
{/* Hashtag filter banner */}
{hashtagFilter && (
  <div className="flex items-center gap-2 border-b border-border bg-panel2 px-4 py-2 text-sm">
    <span className="text-muted">Filtered:</span>
    <span className={hashtagFilter.startsWith("$") ? "font-mono text-amber-400 font-semibold" : "font-mono text-accent"}>
      {hashtagFilter}
    </span>
    <button
      type="button"
      className="ml-auto rounded p-1 hover:bg-border transition"
      onClick={() => setHashtagFilter(null)}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
)}
```

Find where the vendor card should go — above the filtered message list. Add a `VendorCard` inline component within `TopicView`:

```tsx
{/* Vendor card for $symbol filters */}
{hashtagFilter?.startsWith("$") && (() => {
  const sym = symbols.find((s) => s.symbol === hashtagFilter.slice(1));
  if (!sym) return null;
  return (
    <div className="mx-4 mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="flex items-center gap-3">
        {sym.linkedUserAvatarUrl ? (
          <img src={sym.linkedUserAvatarUrl} alt="" className="h-10 w-10 rounded-full object-cover shrink-0" />
        ) : (
          <div className="h-10 w-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
            <span className="text-amber-400 font-bold text-sm">{sym.symbol.slice(0, 1).toUpperCase()}</span>
          </div>
        )}
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-amber-400 font-semibold">${sym.symbol}</span>
            <span className="font-medium text-text">{sym.name}</span>
          </div>
          {sym.description && <p className="text-xs text-muted mt-0.5">{sym.description}</p>}
          {sym.linkedUserDisplayName && (
            <p className="text-xs text-muted mt-0.5">@{sym.linkedUserDisplayName}</p>
          )}
        </div>
      </div>
    </div>
  );
})()}
```

- [ ] **Step 9: Conditionally render filtered list vs normal list + hide composer**

Wrap the main message list section and composer so that when `hashtagFilter` is set, the filtered messages show instead and the composer is hidden. The pattern:

```tsx
{hashtagFilter ? (
  <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
    {filteredLoading && <p className="text-sm text-muted text-center py-8">Loading…</p>}
    {!filteredLoading && filteredMessages.length === 0 && (
      <p className="text-sm text-muted text-center py-8">No messages with {hashtagFilter} yet.</p>
    )}
    {filteredMessages.map((msg) => (
      /* Render using the same MessageBubble component as the normal list */
      <MessageBubble key={msg.id} message={msg} /* same props pattern as normal list */ />
    ))}
  </div>
) : (
  /* existing normal message list JSX */
)}

{/* Composer: hide when filtering */}
{!hashtagFilter && (
  /* existing composer JSX */
)}
```

Note: identify the exact JSX for the message list container and composer in the current `TopicView.tsx` and wrap accordingly.

- [ ] **Step 10: Wrap render output in `HashtagClickContext.Provider`**

Find the top-level `return (` in `TopicView` and wrap the entire content:

```tsx
return (
  <HashtagClickContext.Provider value={{ onHashtagClick: setHashtagFilter }}>
    {/* all existing TopicView JSX */}
  </HashtagClickContext.Provider>
);
```

- [ ] **Step 11: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add apps/web/components/TopicView.tsx
git commit -m "feat(web): TopicView hashtag filter mode, vendor card, and tag extraction on send"
```

---

## Task 12: Admin Symbols Panel

**Files:**
- Create: `apps/web/components/AdminSymbolsPanel.tsx`
- Create: `apps/web/app/admin/symbols/page.tsx`
- Modify: `apps/web/components/AppSidebar.tsx`

- [ ] **Step 1: Create `apps/web/components/AdminSymbolsPanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Pencil, Trash2, Plus, X } from "lucide-react";

interface AdminSymbolRow {
  id: number;
  symbol: string;
  name: string;
  description: string | null;
  linkedUserId: string | null;
  linkedUserDisplayName: string | null;
  linkedUserAvatarUrl: string | null;
}

interface UserOption {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export function AdminSymbolsPanel() {
  const [rows, setRows] = useState<AdminSymbolRow[]>([]);
  const [editing, setEditing] = useState<AdminSymbolRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ symbol: "", name: "", description: "", linkedUserId: "" });
  const [userSearch, setUserSearch] = useState("");
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    fetch("/api/admin/symbols")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => undefined);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (userSearch.length < 2) { setUserOptions([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/users?q=${encodeURIComponent(userSearch)}&limit=8`)
        .then((r) => r.ok ? r.json() : [])
        .then((data: UserOption[]) => setUserOptions(data))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [userSearch]);

  function openCreate() {
    setForm({ symbol: "", name: "", description: "", linkedUserId: "" });
    setUserSearch("");
    setUserOptions([]);
    setEditing(null);
    setCreating(true);
    setError(null);
  }

  function openEdit(row: AdminSymbolRow) {
    setForm({
      symbol: row.symbol,
      name: row.name,
      description: row.description ?? "",
      linkedUserId: row.linkedUserId ?? "",
    });
    setUserSearch(row.linkedUserDisplayName ?? "");
    setUserOptions([]);
    setEditing(row);
    setCreating(false);
    setError(null);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        symbol: form.symbol.toLowerCase().trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        linkedUserId: form.linkedUserId || null,
      };
      const url = editing ? `/api/admin/symbols/${editing.id}` : "/api/admin/symbols";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Save failed");
        return;
      }
      load();
      closeForm();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this symbol? Historical messages keep the data but it stops rendering as styled.")) return;
    await fetch(`/api/admin/symbols/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">Admin-defined $ticker symbols, optionally linked to a vendor user.</p>
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 transition"
        >
          <Plus className="h-4 w-4" /> New Symbol
        </button>
      </div>

      {/* Form */}
      {(creating || editing) && (
        <div className="mb-6 rounded-xl border border-border bg-panel2 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-medium">{editing ? `Edit $${editing.symbol}` : "New Symbol"}</h3>
            <button type="button" onClick={closeForm}><X className="h-4 w-4 text-muted" /></button>
          </div>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <span className="text-muted font-mono text-sm">$</span>
              <input
                className="flex-1 rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="symbol (e.g. gv)"
                value={form.symbol}
                onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") }))}
              />
            </div>
            <input
              className="rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
              placeholder="Name (e.g. Green Valley)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <textarea
              className="rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent resize-none"
              placeholder="Description (optional)"
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            {/* User picker */}
            <div className="relative">
              <input
                className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
                placeholder="Link to user (optional — type to search)"
                value={userSearch}
                onChange={(e) => { setUserSearch(e.target.value); if (!e.target.value) setForm((f) => ({ ...f, linkedUserId: "" })); }}
              />
              {userOptions.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-border bg-panel shadow-lg">
                  {userOptions.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-panel2 transition"
                      onClick={() => {
                        setForm((f) => ({ ...f, linkedUserId: u.id }));
                        setUserSearch(u.displayName);
                        setUserOptions([]);
                      }}
                    >
                      {u.avatarUrl && <img src={u.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
                      {u.displayName}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={closeForm} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-border transition">Cancel</button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !form.symbol || !form.name}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/80 disabled:opacity-50 transition"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2 text-muted text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-2 text-left">Symbol</th>
              <th className="px-4 py-2 text-left">Name</th>
              <th className="px-4 py-2 text-left">Linked User</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No symbols yet.</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border hover:bg-panel2/50 transition">
                <td className="px-4 py-3 font-mono text-amber-400 font-semibold">${row.symbol}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{row.name}</div>
                  {row.description && <div className="text-xs text-muted">{row.description}</div>}
                </td>
                <td className="px-4 py-3">
                  {row.linkedUserDisplayName ? (
                    <div className="flex items-center gap-2">
                      {row.linkedUserAvatarUrl && <img src={row.linkedUserAvatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
                      {row.linkedUserDisplayName}
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button type="button" onClick={() => openEdit(row)} className="rounded p-1.5 hover:bg-border transition"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => void remove(row.id)} className="rounded p-1.5 hover:bg-red-500/10 text-red-400 transition"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `apps/web/app/admin/symbols/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { PERMISSIONS } from "@legends/shared";
import { getCurrentUser } from "@/lib/auth";
import { AdminSymbolsPanel } from "@/components/AdminSymbolsPanel";

export const dynamic = "force-dynamic";

export default async function AdminSymbolsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) redirect("/");

  return (
    <main className="flex-1 p-4 sm:p-8">
      <h1 className="mb-2 text-2xl font-semibold">Symbols</h1>
      <p className="mb-6 text-sm text-muted">Define $ticker symbols and link them to vendor users.</p>
      <AdminSymbolsPanel />
    </main>
  );
}
```

- [ ] **Step 3: Add Symbols nav link to `AppSidebar.tsx`**

In `apps/web/components/AppSidebar.tsx`, in the `AdminNav` function, add alongside other admin links:

```tsx
{isAdmin && <NavLink href="/admin/symbols" icon={<Hash className="h-4 w-4" />} label="Symbols" />}
```

Add `Hash` to the lucide-react import at the top of the file.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 5: Add user search endpoint (if not already present)**

Check if `/api/users?q=` exists:

```bash
ls /home/mrlucifer/repos/legends-chat/apps/web/app/api/users/
```

If a `route.ts` with `GET` and `?q=` search exists, skip this step. If not, create `apps/web/app/api/users/route.ts`:

```ts
import { NextResponse } from "next/server";
import { ilike, limit as drizzleLimit } from "drizzle-orm";
import { users } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { PERMISSIONS } from "@legends/shared";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.ADMIN_CONFIG)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json([]);

  const rows = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(ilike(users.displayName, `%${q}%`))
    .limit(8);

  return NextResponse.json(rows);
}
```

- [ ] **Step 6: Final full type-check**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1
npx tsc --noEmit -p apps/ws/tsconfig.json 2>&1
npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1
npx tsc --noEmit -p packages/db/tsconfig.json 2>&1
```

Expected: no errors in any package.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/AdminSymbolsPanel.tsx apps/web/app/admin/symbols/ apps/web/components/AppSidebar.tsx
git commit -m "feat(web): admin symbols CRUD panel and nav link"
```

---

## Final Verification

- [ ] **Run migration against dev DB**

```bash
cd /home/mrlucifer/repos/legends-chat
# Apply migration — adjust command to match your DB tooling:
npx drizzle-kit push 2>&1
# or: psql $DATABASE_URL -f packages/db/src/migrations/0029_hashtags_symbols.sql
```

Expected: no SQL errors, `messages.hashtags` column exists, `symbols` table exists.

- [ ] **Manual smoke test checklist**

1. Send a message with `#hello` — verify sidebar preview strips the tag formatting  
2. Open topic info modal — verify `#hello` appears in tag cloud  
3. Click `#hello` in modal — modal closes, filter banner appears in chat, filtered messages shown  
4. Click X in banner — normal chat restored  
5. Admin → Symbols: create `$gv` linked to a user  
6. Send a message with `$gv` — verify it renders gold/amber in message  
7. Click `$gv` in message — vendor card appears above filtered list  
8. Type `#` in composer — autocomplete shows existing topic tags  
9. Type `$` in composer — autocomplete shows admin symbols  
10. `$unknown` typed in a message — renders as plain text, no special styling

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat: hashtag tracking, \$symbol vendor tags, tag cloud, and autocomplete"
```
