# Direct Messages — Plan C: Plaintext bot DMs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users open and exchange messages with a bot via the existing DM subsystem — plaintext only, no bot keypair, additive to Plan A (no breaking changes to user↔user DMs or existing topic-based bot messaging).

**Architecture:** A bot becomes a DM participant principal (`principal_type='bot'`) — the Plan A schema already supports this. A new `bots.dm_enabled` flag opts a bot in. `/api/dm/search` and `POST /api/dm` accept the bot peer type. The bot HTTP API gains a `conversationId` addressing on `sendMessage`. A new web-side producer dispatches `dm_message` updates into the same `legends:bot:updates:<botId>` Redis queue + webhook the topic-message path already uses, so SDK polling/webhook ingestion is unified. The SDK gains a `DmMessageContext` and `sendDmMessage`. The DM UI lists bot conversations and the sidebar gains a "Bots" entry.

**Tech Stack:** Drizzle ORM + Postgres, ioredis (rpush queue + pub/sub), zod, Next.js 15 (App Router), socket.io (`apps/ws`), `@legends/bot-sdk`. Spec: `docs/superpowers/specs/2026-05-28-direct-messages-design.md`. Prior plan: `docs/superpowers/plans/2026-05-28-direct-messages-plan-a-plaintext-core.md`.

**Scope of Plan C (and what is NOT included):** Plaintext bot DMs, user-initiated only. Bot DMs are always `is_e2ee=false`. NO bot keypair / `bot_key_bundles` / E2EE bot endpoint (that's a separate future plan). NO bot-initiated DM creation (a bot can only reply inside a conversation a user opened). NO inline keyboards / media in DMs (deferred — they'd be server-readable and Plan A intentionally omits them). NO bot blocking via `dm_blocks` (the table is user↔user only by design; if a user doesn't want a bot, they don't DM it). Existing topic-based bot messaging and the user↔user DM flows must keep working unchanged.

---

## Test / verification strategy

Same as Plan A: `pnpm --filter @legends/db typecheck` (excluding the pre-existing `create-admin.ts` error), `pnpm --filter @legends/web typecheck`, `pnpm --filter @legends/ws typecheck`, `pnpm --filter @legends/bot-sdk typecheck`. The existing vitest in `packages/db` is reused for any pure-logic units (Plan C has none beyond Plan A's `buildDmKey`, which already works for bot principals — Task 1 of Plan A includes that test). A `tsx` smoke script exercises the bot delivery (rpush + queue length check). Live manual smoke uses a real SDK bot ( `apps/bots/jane` or a new throwaway) — same servers as Plan A.

Commands (PATH note: `pnpm` is at `~/.npm-global/bin/pnpm` — prepend it).

---

## File structure

**Modify:**
- `packages/db/src/schema.ts` — `bots.dmEnabled boolean default false`.
- `packages/db/src/migrations/0036_bots_dm_enabled.sql` (new file in migrations dir) + `meta/_journal.json` entry.
- `packages/shared/src/events.ts` — add `REDIS_CHANNELS.DM_BOT_UPDATE` (so any bot-update producer that needs cross-process fan-out has a channel; see Task 6 for whether we actually need it — web can rpush directly).
- `packages/bot-sdk/src/types.ts` — `DmMessageUpdate`, extend `Update`, `SendDmMessageParams`.
- `packages/bot-sdk/src/client.ts` — `sendDmMessage`.
- `packages/bot-sdk/src/bot.ts` — `DmMessageContext`, `on("dm_message", …)`, `handleUpdate` branch.
- `packages/bot-sdk/src/index.ts` — re-export new context + types.
- `apps/web/lib/dm.ts` — extend `openConversation`/`openUserConversation` to accept `peerType: "user"|"bot"`, extend `listConversations` to resolve bot peers, generalize `recipientUserIds` → `recipientUserIds` (still user-only — bots reached via the new bot-delivery path, NOT via the existing `DM_MESSAGE_NEW` ws relay).
- `apps/web/app/api/dm/route.ts` — POST schema accepts `peerType: "user"|"bot"` and routes to the right branch.
- `apps/web/app/api/dm/search/route.ts` — also returns dm-enabled bots.
- `apps/web/app/api/dm/[id]/messages/route.ts` — after insert, call the new bot-delivery helper (in addition to existing user fan-out).
- `apps/web/app/api/bot/v1/sendMessage/route.ts` — accept `conversationId` (mutually exclusive with `topicId`) → DM send branch.
- `apps/web/components/DmClient.tsx` — render bot peers with a "BOT" badge, support a `?tab=bots` filter, include bots in search results.
- `apps/web/components/AppSidebar.tsx` — add a "Bots" link to the chat-variant sidebar.

**Create:**
- `apps/web/lib/dm-bot-delivery.ts` — `deliverDmToBots(conversationId, message)` that rpushes an `Update` to each bot participant's `legends:bot:updates:<botId>` queue (matches `apps/ws/src/webhook.ts:38-50` shape) and POSTs the webhookUrl with a 5s timeout.

**Untouched (by design):**
- `dm_messages` schema (already supports `senderType='bot'`).
- `dm_sender_keys` (E2EE only — bot DMs are plaintext-only this plan).
- `dm_blocks` (user↔user only).
- The user↔user DM API, ws relay, and UI flows from Plan A.
- The existing topic-based bot path (`messages` table, `topic_bots`, the `deliverMessageToWebhooks` producer in `apps/ws/src/webhook.ts`).

---

## Task 1: `bots.dmEnabled` column + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0036_bots_dm_enabled.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add the column to schema.ts**

In `packages/db/src/schema.ts`, find the `bots` table definition (it has columns `id`, `name`, `ownerUserId`, `tokenHash`, `avatarUrl`, `description`, `webhookUrl`, `isActive`, `createdAt`, `role`, `roleExpiresAt`, `roleFallback`). Add **after** `isActive`:

```ts
    dmEnabled: boolean("dm_enabled").notNull().default(false),
```

(`boolean` is already imported at the top of the file.)

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/src/migrations/0036_bots_dm_enabled.sql`:

```sql
-- Plan C: opt-in flag for bots to be DM-able by users.
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "dm_enabled" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 3: Append the journal entry**

Open `packages/db/src/migrations/meta/_journal.json`. Last entry should be `idx: 35` (the DM tables from Plan A). Append:

```json
{
  "idx": 36,
  "version": "7",
  "when": 1779700000000,
  "tag": "0036_bots_dm_enabled",
  "breakpoints": true
}
```

(Use a `when` strictly greater than the previous entry — read the file and bump if `1779700000000` is not already greater.)

- [ ] **Step 4: Apply and verify**

Run (controller, with PATH + .env sourced): `pnpm db:migrate`
Expected: `migrations applied`.
Verify:
`pnpm --filter @legends/db exec tsx -e "import postgres from 'postgres'; const s=postgres(process.env.DATABASE_URL); console.log(await s\`select column_name, data_type, column_default from information_schema.columns where table_name='bots' and column_name='dm_enabled'\`); await s.end();"`
Expected: shows `dm_enabled | boolean | false`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @legends/db typecheck`
Expected: no NEW errors (the pre-existing `create-admin.ts` error remains; ignore it).

---

## Task 2: Server DM helpers — bot peer support

**Files:**
- Modify: `apps/web/lib/dm.ts`

The Plan A helpers assumed user↔user. Extend (do NOT break the existing user↔user path used by `/api/dm` POST and `listConversations`).

- [ ] **Step 1: Generalize `openUserConversation` → `openConversation`**

In `apps/web/lib/dm.ts`, replace the existing `openUserConversation` function with the generalized version below. (Keep all other helpers — `currentDataKey`, `getKeyData`, `isBlockedBetween`, `assertParticipant`, `insertDmMessage`, `recipientUserIds` — unchanged.)

```ts
import { bots } from "@legends/db/schema";
// add `bots` to the existing `@legends/db/schema` import line at the top
// (next to dmConversations, dmParticipants, dmMessages, dmBlocks, encryptionKeys, users)

// Replace openUserConversation with:
export async function openConversation(
  initiatorUserId: string,
  peer: { type: "user" | "bot"; id: string },
): Promise<{ id: string; created: boolean }> {
  if (peer.type === "user" && initiatorUserId === peer.id) {
    throw Object.assign(new Error("cannot DM yourself"), { code: "BAD" });
  }
  if (peer.type === "user" && (await isBlockedBetween(initiatorUserId, peer.id))) {
    throw Object.assign(new Error("blocked"), { code: "BLOCKED" });
  }
  if (peer.type === "bot") {
    const [b] = await db.select({ id: bots.id, dmEnabled: bots.dmEnabled, isActive: bots.isActive }).from(bots).where(eq(bots.id, peer.id)).limit(1);
    if (!b || !b.isActive || !b.dmEnabled) throw Object.assign(new Error("bot not dm-able"), { code: "BAD" });
  }

  const dmKey = buildDmKey({ type: "user", id: initiatorUserId }, peer);
  const existing = await db.select({ id: dmConversations.id }).from(dmConversations).where(eq(dmConversations.dmKey, dmKey)).limit(1);
  if (existing[0]) return { id: existing[0].id, created: false };

  const state = peer.type === "bot" ? "accepted" : "pending";
  const [conv] = await db
    .insert(dmConversations)
    .values({ dmKey, isE2ee: false, state, initiatorType: "user", initiatorId: initiatorUserId })
    .onConflictDoNothing({ target: dmConversations.dmKey })
    .returning({ id: dmConversations.id });
  if (!conv) {
    const [row] = await db.select({ id: dmConversations.id }).from(dmConversations).where(eq(dmConversations.dmKey, dmKey)).limit(1);
    return { id: row!.id, created: false };
  }
  await db.insert(dmParticipants).values([
    { conversationId: conv.id, principalType: "user", principalId: initiatorUserId },
    { conversationId: conv.id, principalType: peer.type, principalId: peer.id },
  ]).onConflictDoNothing();
  return { id: conv.id, created: true };
}

// Keep a thin compat alias so the existing /api/dm POST keeps working until Task 3 lands:
export async function openUserConversation(initiatorId: string, peerUserId: string) {
  return openConversation(initiatorId, { type: "user", id: peerUserId });
}
```

- [ ] **Step 2: Extend `listConversations` to resolve bot peers**

Replace `listConversations` with:

```ts
export type DmConversationView = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};

export async function listConversations(userId: string): Promise<DmConversationView[]> {
  const myConvs = await db
    .select({ conversationId: dmParticipants.conversationId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.principalType, "user"), eq(dmParticipants.principalId, userId)));
  const ids = myConvs.map((c) => c.conversationId);
  if (ids.length === 0) return [];

  const convs = await db.select().from(dmConversations).where(inArray(dmConversations.id, ids));
  const parts = await db.select().from(dmParticipants).where(inArray(dmParticipants.conversationId, ids));

  const userPeerIds = parts.filter((p) => p.principalType === "user" && p.principalId !== userId).map((p) => p.principalId);
  const botPeerIds = parts.filter((p) => p.principalType === "bot").map((p) => p.principalId);

  const userRows = userPeerIds.length
    ? await db.select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl }).from(users).where(inArray(users.id, userPeerIds))
    : [];
  const botRows = botPeerIds.length
    ? await db.select({ id: bots.id, name: bots.name, avatarUrl: bots.avatarUrl }).from(bots).where(inArray(bots.id, botPeerIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const botById = new Map(botRows.map((b) => [b.id, b]));

  return convs.map((c) => {
    const peerPart = parts.find((p) => p.conversationId === c.id && !(p.principalType === "user" && p.principalId === userId));
    let peer: DmConversationView["peer"] = null;
    if (peerPart?.principalType === "user") {
      const u = userById.get(peerPart.principalId);
      if (u) peer = { type: "user", id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl };
    } else if (peerPart?.principalType === "bot") {
      const b = botById.get(peerPart.principalId);
      if (b) peer = { type: "bot", id: b.id, displayName: b.name, avatarUrl: b.avatarUrl };
    }
    return {
      id: c.id,
      state: c.state,
      isE2ee: c.isE2ee,
      peer,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      incoming: c.state === "pending" && c.initiatorId !== userId,
    };
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors. (`recipientUserIds` is unchanged and continues to return ONLY user principals — bots are reached via the new bot-delivery helper in Task 6.)

---

## Task 3: API — `/api/dm` open accepts bot peer; `/api/dm/search` includes bots

**Files:**
- Modify: `apps/web/app/api/dm/route.ts`
- Modify: `apps/web/app/api/dm/search/route.ts`

- [ ] **Step 1: `/api/dm` POST accepts bot peer**

In `apps/web/app/api/dm/route.ts`, replace the `openSchema` zod and the POST handler body with:

```ts
const openSchema = z.object({
  peerType: z.enum(["user", "bot"]),
  peerId: z.string().uuid(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = openSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const { id, created } = await openConversation(user.id, { type: parsed.data.peerType, id: parsed.data.peerId });
    return NextResponse.json({ id, created }, { status: created ? 201 : 200 });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "BLOCKED") return NextResponse.json({ error: "blocked" }, { status: 403 });
    if (code === "BAD") return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    throw e;
  }
}
```

Update the import at the top: replace `import { openUserConversation, listConversations } from "@/lib/dm";` with `import { openConversation, listConversations } from "@/lib/dm";`.

- [ ] **Step 2: `/api/dm/search` returns users + dm-enabled bots**

In `apps/web/app/api/dm/search/route.ts`, replace the GET handler with:

```ts
import { NextResponse } from "next/server";
import { and, eq, ilike, ne } from "drizzle-orm";
import { users, bots } from "@legends/db/schema";
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
  if (q.length > 64) return NextResponse.json([]);

  const [userRows, botRows] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(and(ilike(users.displayName, `%${q}%`), ne(users.id, user.id), eq(users.isAnon, false)))
      .limit(6),
    db
      .select({ id: bots.id, displayName: bots.name, avatarUrl: bots.avatarUrl })
      .from(bots)
      .where(and(ilike(bots.name, `%${q}%`), eq(bots.dmEnabled, true), eq(bots.isActive, true)))
      .limit(4),
  ]);
  const out = [
    ...userRows.map((u) => ({ type: "user" as const, ...u })),
    ...botRows.map((b) => ({ type: "bot" as const, ...b })),
  ];
  return NextResponse.json(out);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

---

## Task 4: Bot DM delivery helper

**Files:**
- Create: `apps/web/lib/dm-bot-delivery.ts`

This mirrors the rpush+webhook pattern from `apps/ws/src/webhook.ts:38-50` but runs in the web process (the web route inserts the DM message, so dispatching from there avoids a Redis hop). Each bot has an `legends:bot:updates:<botId>` queue (FIFO) that `getUpdates` long-polls. We rpush an `Update` and also POST to `webhookUrl` if set.

- [ ] **Step 1: Implement the helper**

Create `apps/web/lib/dm-bot-delivery.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { bots, dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

const UPDATE_QUEUE_TTL = 300; // mirror apps/ws/src/webhook.ts

// Same shape the SDK polls in apps/ws/src/webhook.ts WebhookUpdate, extended
// with a "dm_message" variant. Kept inline here so this helper has no cross-
// process import; the SDK declares the matching type in packages/bot-sdk.
type DmMessageEnvelope = {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text: string;
  reply_to_message_id?: string;
  date: number;
};
type DmUpdate = {
  update_id: string;
  type: "dm_message";
  dm_message: DmMessageEnvelope;
};

let counter = 0;
function nextId(): string { return String(++counter); }

async function botParticipantsFor(conversationId: string): Promise<{ botId: string; webhookUrl: string | null }[]> {
  const partRows = await db
    .select({ principalId: dmParticipants.principalId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.principalType, "bot")));
  const ids = partRows.map((p) => p.principalId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ botId: bots.id, webhookUrl: bots.webhookUrl })
    .from(bots)
    .where(and(inArray(bots.id, ids), eq(bots.isActive, true), eq(bots.dmEnabled, true)));
  return rows;
}

async function dispatch(botId: string, webhookUrl: string | null, update: DmUpdate): Promise<void> {
  const serialized = JSON.stringify(update);
  const queueKey = `legends:bot:updates:${botId}`;
  await Promise.all([
    redis.rpush(queueKey, serialized).then(() => redis.expire(queueKey, UPDATE_QUEUE_TTL)),
    webhookUrl
      ? fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: serialized,
          signal: AbortSignal.timeout(5000),
        }).catch(() => {})
      : Promise.resolve(),
  ]);
}

export async function deliverDmToBots(
  conversationId: string,
  msg: {
    id: string;
    senderType: "user" | "bot";
    senderId: string;
    senderDisplayName: string | null;
    text: string;
    replyToMessageId: string | null;
    createdAt: string;
  },
): Promise<void> {
  // Skip if the sender is itself a bot (don't loop a bot's own messages back to it).
  // (Plan C only has user-authored sends via /api/dm/[id]/messages, so this is defensive.)
  if (msg.senderType === "bot") return;

  const targets = await botParticipantsFor(conversationId);
  if (targets.length === 0) return;

  const update: DmUpdate = {
    update_id: nextId(),
    type: "dm_message",
    dm_message: {
      message_id: msg.id,
      conversation_id: conversationId,
      from: { id: msg.senderId, display_name: msg.senderDisplayName },
      text: msg.text,
      reply_to_message_id: msg.replyToMessageId ?? undefined,
      date: Math.floor(new Date(msg.createdAt).getTime() / 1000),
    },
  };

  await Promise.all(targets.map((t) => dispatch(t.botId, t.webhookUrl, update)));
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

---

## Task 5: Wire bot delivery into the DM messages route

**Files:**
- Modify: `apps/web/app/api/dm/[id]/messages/route.ts`

- [ ] **Step 1: Call the bot delivery helper after insert**

In `apps/web/app/api/dm/[id]/messages/route.ts`, find the POST handler. After `insertDmMessage(...)` returns `msg`, after the existing `await redis.publish(REDIS_CHANNELS.DM_MESSAGE_NEW, JSON.stringify({ conversationId: id, message: msg, userIds: allParticipants }));` line, add:

```ts
// Also dispatch to any bot participants of this conversation (Plan C).
// Sender display name is the current user's name; bots receive plaintext.
import("@/lib/dm-bot-delivery").then(({ deliverDmToBots }) =>
  deliverDmToBots(id, {
    id: msg.id,
    senderType: "user",
    senderId: user.id,
    senderDisplayName: user.displayName,
    text: parsed.data.text,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
    createdAt: msg.createdAt,
  }).catch((e) => console.error("[dm-bot-delivery] failed", e)),
);
```

(Use the dynamic `import(...)` form to keep the bot-delivery module out of the cold path for purely user-user DMs that have no bot participant. Alternatively, replace with a normal `import { deliverDmToBots } from "@/lib/dm-bot-delivery";` at the top of the file and an `await` — both work.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

---

## Task 6: Bot HTTP API — `sendMessage` accepts `conversationId`

**Files:**
- Modify: `apps/web/app/api/bot/v1/sendMessage/route.ts`

Currently the route requires `topicId`. Add a parallel branch when `conversationId` is provided.

- [ ] **Step 1: Add the DM send branch**

In `apps/web/app/api/bot/v1/sendMessage/route.ts`, replace the body interface and the early validation/topic branch. The complete updated POST handler:

```ts
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  bots, dmConversations, dmMessages, dmParticipants,
  encryptionKeys, messages, topicBots, topicPrincipalGrants, topics, users,
} from "@legends/db/schema";
import { canPrincipal, REDIS_CHANNELS, type GrantEffect, type TopicGrant } from "@legends/shared";
import { encryptMessage, unwrapKey, generateDataKey, wrapKey } from "@legends/crypto";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";

interface InlineKeyboardButton { text: string; callbackData: string }

async function currentDataKey(): Promise<{ id: string; data: Uint8Array }> {
  const { desc } = await import("drizzle-orm");
  const rows = await db.select().from(encryptionKeys).where(eq(encryptionKeys.purpose, "messages")).orderBy(desc(encryptionKeys.createdAt)).limit(1);
  if (rows[0]) return { id: rows[0].id, data: unwrapKey(rows[0].wrappedKey) };
  const data = generateDataKey();
  const { wrapped } = wrapKey(data);
  const [inserted] = await db.insert(encryptionKeys).values({ purpose: "messages", wrappedKey: wrapped }).returning();
  return { id: inserted!.id, data };
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json() as {
    topicId?: string;
    conversationId?: string;
    text: string;
    replyToMessageId?: string;
    inlineKeyboard?: InlineKeyboardButton[][];
  };
  if (!body.text?.trim()) {
    return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });
  }
  if ((body.topicId && body.conversationId) || (!body.topicId && !body.conversationId)) {
    return NextResponse.json({ ok: false, error: "exactly one of topicId or conversationId required" }, { status: 400 });
  }

  // ── DM branch ──────────────────────────────────────────────────────────────
  if (body.conversationId) {
    const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, body.conversationId)).limit(1);
    if (!conv) return NextResponse.json({ ok: false, error: "conversation not found" }, { status: 404 });
    if (conv.isE2ee) return NextResponse.json({ ok: false, error: "bots cannot send to E2EE DMs (plan B)" }, { status: 400 });
    if (conv.state === "blocked") return NextResponse.json({ ok: false, error: "blocked" }, { status: 403 });

    const [part] = await db
      .select({ pid: dmParticipants.principalId })
      .from(dmParticipants)
      .where(and(
        eq(dmParticipants.conversationId, body.conversationId),
        eq(dmParticipants.principalType, "bot"),
        eq(dmParticipants.principalId, bot.id),
      ))
      .limit(1);
    if (!part) return NextResponse.json({ ok: false, error: "bot not in conversation" }, { status: 403 });

    if (body.inlineKeyboard && body.inlineKeyboard.length > 0) {
      return NextResponse.json({ ok: false, error: "inline keyboards not supported in DMs (yet)" }, { status: 400 });
    }

    const key = await currentDataKey();
    const aad = new TextEncoder().encode(body.conversationId);
    const { ciphertext, nonce } = encryptMessage(key.data, body.text.trim(), aad);
    const [row] = await db.insert(dmMessages).values({
      conversationId: body.conversationId,
      senderType: "bot",
      senderId: bot.id,
      contentCiphertext: ciphertext,
      contentNonce: nonce,
      keyId: key.id,
      replyToMessageId: body.replyToMessageId && /^\d+$/.test(body.replyToMessageId) ? BigInt(body.replyToMessageId) : null,
    }).returning();
    await db.update(dmConversations).set({ lastMessageAt: row!.createdAt }).where(eq(dmConversations.id, body.conversationId));

    // Fan out to user participants via the existing ws relay (Plan A path).
    const userParts = await db
      .select({ pid: dmParticipants.principalId })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, body.conversationId), eq(dmParticipants.principalType, "user")));
    const userIds = userParts.map((p) => p.pid);
    const msgOut = {
      id: row!.id.toString(),
      conversationId: body.conversationId,
      senderType: "bot" as const,
      senderId: bot.id,
      text: body.text.trim(),
      replyToMessageId: body.replyToMessageId ?? null,
      createdAt: row!.createdAt.toISOString(),
      editedAt: null,
    };
    await redis.publish(REDIS_CHANNELS.DM_MESSAGE_NEW, JSON.stringify({ conversationId: body.conversationId, message: msgOut, userIds }));

    return NextResponse.json({ ok: true, result: { messageId: row!.id.toString() } }, { status: 201 });
  }

  // ── Topic branch (existing behavior, unchanged) ────────────────────────────
  const topicId = body.topicId!;
  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ ok: false, error: "topic not found" }, { status: 404 });
  if (topic.isE2ee) return NextResponse.json({ ok: false, error: "bots cannot send to E2EE topics" }, { status: 400 });

  const [assignment] = await db.select().from(topicBots).where(and(eq(topicBots.botId, bot.id), eq(topicBots.topicId, topicId))).limit(1);
  if (!assignment) return NextResponse.json({ ok: false, error: "bot not assigned to topic" }, { status: 403 });

  const now = new Date();
  const grantRows = await db
    .select({ action: topicPrincipalGrants.action, effect: topicPrincipalGrants.effect })
    .from(topicPrincipalGrants)
    .where(and(
      eq(topicPrincipalGrants.topicId, topicId),
      eq(topicPrincipalGrants.principalType, "bot"),
      eq(topicPrincipalGrants.principalId, bot.id),
      or(isNull(topicPrincipalGrants.expiresAt), gt(topicPrincipalGrants.expiresAt, now)),
    ));
  const grants: TopicGrant[] = grantRows.map((g) => ({ action: g.action, effect: g.effect as GrantEffect }));
  const isReply = !!body.replyToMessageId;
  const [topicDetail] = await db.select({ postRoles: topics.postRoles, replyRoles: topics.replyRoles, isFeed: topics.isFeed }).from(topics).where(eq(topics.id, topicId)).limit(1);
  const actionRoles = isReply && topicDetail?.isFeed
    ? ((topicDetail?.replyRoles as string[] | null) ?? [])
    : ((topicDetail?.postRoles as string[] | null) ?? []);
  const action = isReply && topicDetail?.isFeed ? "reply" : "post";
  if (!canPrincipal(grants, actionRoles, bot.role, action)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const key = await currentDataKey();
  const aad = new TextEncoder().encode(topicId);
  const { ciphertext, nonce } = encryptMessage(key.data, body.text.trim(), aad);
  const [row] = await db.insert(messages).values({
    topicId,
    senderUserId: null,
    botId: bot.id,
    replyToMessageId: body.replyToMessageId ? BigInt(body.replyToMessageId) : null,
    contentCiphertext: ciphertext,
    contentNonce: nonce,
    keyId: key.id,
    inlineKeyboard: body.inlineKeyboard ?? null,
  }).returning();

  const [botUser] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, bot.ownerUserId)).limit(1);
  void botUser;

  const msgOut = {
    id: row!.id.toString(),
    topicId: row!.topicId,
    senderUserId: null,
    senderDisplayName: bot.name,
    senderAvatarUrl: bot.avatarUrl,
    senderIsAnon: false,
    botId: bot.id,
    replyToMessageId: row!.replyToMessageId?.toString() ?? null,
    text: body.text.trim(),
    attachments: [],
    inlineKeyboard: body.inlineKeyboard ?? null,
    createdAt: row!.createdAt,
    editedAt: null,
  };
  await redis.publish(REDIS_CHANNELS.BOT_MESSAGE_NEW, JSON.stringify({ topicId, message: msgOut }));
  return NextResponse.json({ ok: true, result: { messageId: row!.id.toString() } }, { status: 201 });
}
```

The topic branch is **unchanged** from the current handler; the DM branch is new. Both share the same `currentDataKey` helper.

- [ ] **Step 2: Typecheck + existing-behavior sanity check**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

Manual sanity (no bot DM yet): an existing topic-send via `apps/bots/jane` or `chaos` still works (sends with `topicId` only). The new branch is keyed on `body.conversationId` so the topic path is untouched at runtime when the field is absent.

---

## Task 7: SDK — `dm_message` update, `sendDmMessage`, `DmMessageContext`

**Files:**
- Modify: `packages/bot-sdk/src/types.ts`
- Modify: `packages/bot-sdk/src/client.ts`
- Modify: `packages/bot-sdk/src/bot.ts`
- Modify: `packages/bot-sdk/src/index.ts`

- [ ] **Step 1: Types**

In `packages/bot-sdk/src/types.ts`, add (don't remove existing exports):

```ts
export interface DmMessageUpdate {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text: string;
  reply_to_message_id?: string;
  date: number;
}

export interface SendDmMessageParams {
  conversationId: string;
  text: string;
  replyToMessageId?: string;
}
```

And extend the `Update` interface to include `dm_message` and the new type string:

```ts
export interface Update {
  update_id: string;
  type: "message" | "callback_query" | "new_member" | "dm_message" | string;
  message?: MessageUpdate;
  callback_query?: CallbackQueryUpdate;
  new_member?: NewMemberUpdate;
  dm_message?: DmMessageUpdate;
}
```

- [ ] **Step 2: Client — `sendDmMessage`**

In `packages/bot-sdk/src/client.ts`, add an import: `import type { ..., SendDmMessageParams } from "./types.js";` (alongside existing type imports). Add the method:

```ts
  async sendDmMessage(params: SendDmMessageParams): Promise<{ messageId: string }> {
    return this.call<{ messageId: string }>("sendMessage", params);
  }
```

Note: this calls the same `sendMessage` server endpoint; the route discriminates by `conversationId` vs `topicId` (Task 6). Keeping a separate method on the client signals intent and avoids overloading `sendMessage`'s param type.

- [ ] **Step 3: `DmMessageContext` + `on("dm_message", …)`**

In `packages/bot-sdk/src/bot.ts`, after `CallbackQueryContext`, add:

```ts
export class DmMessageContext {
  constructor(
    public readonly bot: LegendsBot,
    public readonly update: Update,
    public readonly dm_message: DmMessageUpdate,
  ) {}

  get conversationId(): string { return this.dm_message.conversation_id; }

  async reply(text: string, options?: Omit<SendDmMessageParams, "conversationId" | "text">): Promise<{ messageId: string }> {
    return this.bot.api.sendDmMessage({ conversationId: this.conversationId, text, ...options });
  }
}
```

Add `DmMessageUpdate` and `SendDmMessageParams` to the existing type import at the top of `bot.ts`.

Add the handler array, the `on` overload, and the dispatch branch in `handleUpdate`. Updated relevant blocks:

```ts
type DmMsgHandler = (ctx: DmMessageContext) => Promise<void> | void;

// Inside LegendsBot._handlers:
  private readonly _handlers = {
    message: [] as MsgHandler[],
    new_member: [] as MemberHandler[],
    callback_query: [] as CallbackHandler[],
    dm_message: [] as DmMsgHandler[],
  };

// Add a new on() overload (and extend the union signature):
  on(event: "message", handler: MsgHandler): this;
  on(event: "new_member", handler: MemberHandler): this;
  on(event: "callback_query", handler: CallbackHandler): this;
  on(event: "dm_message", handler: DmMsgHandler): this;
  on(event: "message" | "new_member" | "callback_query" | "dm_message", handler: MsgHandler | MemberHandler | CallbackHandler | DmMsgHandler): this {
    (this._handlers[event] as (typeof handler)[]).push(handler);
    return this;
  }

// In handleUpdate, after the callback_query branch:
      } else if (update.type === "dm_message" && update.dm_message) {
        const ctx = new DmMessageContext(this, update, update.dm_message);
        for (const h of this._handlers.dm_message) await h(ctx);
      }
```

- [ ] **Step 4: Re-export**

In `packages/bot-sdk/src/index.ts`, add `DmMessageContext` to the existing `export { LegendsBot, ... } from "./bot.js";` line, and add `DmMessageUpdate, SendDmMessageParams` to the type re-export.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @legends/bot-sdk typecheck`
Expected: no errors.

---

## Task 8: Client UI — bot peers in DmClient + sidebar Bots tab

**Files:**
- Modify: `apps/web/components/DmClient.tsx`
- Modify: `apps/web/components/AppSidebar.tsx`

- [ ] **Step 1: `DmClient` — bot peer rendering + search**

In `apps/web/components/DmClient.tsx`:

1. Update the `Conversation` type's `peer` field to match the server (now includes `type`):

```ts
type Conversation = {
  id: string;
  state: "pending" | "accepted" | "blocked";
  isE2ee: boolean;
  peer: { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null } | null;
  lastMessageAt: string | null;
  incoming: boolean;
};
```

2. Update the `SearchHit` type:

```ts
type SearchHit = { type: "user" | "bot"; id: string; displayName: string; avatarUrl: string | null };
```

3. In the search-hit button, render a small `BOT` tag for bot results, and pass `type` to `startDm`:

```tsx
{hits.map((h) => (
  <button key={`${h.type}:${h.id}`} onClick={() => startDm(h)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-panel">
    {h.displayName}
    {h.type === "bot" && <span className="ml-auto rounded bg-accent2/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent2">bot</span>}
  </button>
))}
```

4. Replace `startDm(peerId: string)` with:

```tsx
async function startDm(peer: SearchHit) {
  const r = await apiFetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerType: peer.type, peerId: peer.id }) });
  if (!r.ok) return;
  const d = (await r.json()) as { id: string };
  setQuery(""); setHits([]);
  await refreshList();
  await openThread(d.id);
}
```

5. In the accepted-conversations list, render a `BOT` tag next to bot-peer rows (analogous to the search-hit version):

```tsx
{accepted.map((c) => (
  <button key={c.id} onClick={() => openThread(c.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-panel2", activeId === c.id && "bg-panel2")}>
    <span className="truncate">{c.peer?.displayName ?? "Unknown"}</span>
    {c.peer?.type === "bot" && <span className="ml-auto rounded bg-accent2/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent2">bot</span>}
  </button>
))}
```

6. Support a "Bots" filter via the URL query string. At the top of `DmClient`, read `window.location.search` for `?tab=bots` (client-side only) and use a local `tab` state. Filter `accepted` when `tab === "bots"`:

```tsx
const [tab, setTab] = useState<"all" | "bots">(() => {
  if (typeof window === "undefined") return "all";
  return new URLSearchParams(window.location.search).get("tab") === "bots" ? "bots" : "all";
});
// ...
const visibleAccepted = tab === "bots" ? accepted.filter((c) => c.peer?.type === "bot") : accepted;
// then render `visibleAccepted` instead of `accepted` in the list above
```

(The sidebar links to `/dm` and `/dm?tab=bots`. No router push needed for switching is necessary — the page is server-rendered initially and the client component reads the URL on mount.)

- [ ] **Step 2: Sidebar — add Bots entry**

In `apps/web/components/AppSidebar.tsx`, in the SAME chat-variant section where Plan A added the `/dm` "Direct Messages" link, add immediately after it:

```tsx
<Link href="/dm?tab=bots" className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-panel2">
  <Bot className="h-4 w-4" /> Bots
</Link>
```

Ensure `Bot` is in the existing `lucide-react` import line — `AdminNav` already imports it (search the file). If the chat-variant import block doesn't include it, add it.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @legends/web typecheck`
Expected: no errors.

---

## Self-review checklist (run before declaring Plan C done)

- [ ] `pnpm -r typecheck` clean (excluding the pre-existing `packages/db/src/create-admin.ts` error).
- [ ] `pnpm --filter @legends/db test:run` still passes (`buildDmKey` already covers the bot principal case from Plan A's tests).
- [ ] Migration 0036 applied; `select dm_enabled from bots limit 1` returns false (default).
- [ ] A live smoke (controller-driven): in dev, set `update bots set dm_enabled = true where id = <some bot>`, then as a user `POST /api/dm {peerType:"bot", peerId:<botId>}` → conversation created, state accepted; `POST /api/dm/[id]/messages {text:"hi"}` → 201; check `redis-cli LRANGE legends:bot:updates:<botId> 0 -1` shows the queued `dm_message` envelope. If the bot has a `webhookUrl`, confirm the webhook fired.
- [ ] Existing topic-based bot send still works (regression check): `apps/bots/jane` or a `curl` to `/api/bot/v1/sendMessage` with `topicId` succeeds unchanged.
- [ ] Spec coverage: `bots.dmEnabled` (T1), bot principal in DM open (T2/T3), search includes bots (T3), bot-to-bot-queue delivery (T4/T5), bot API conversationId send (T6), SDK `on("dm_message")` (T7), UI + sidebar Bots (T8). No `bot_key_bundles`, no E2EE bot DMs, no inline keyboards, no bot blocking (correctly deferred).

---

## Deferred to later plans

- **Plan B (opt-in E2EE for user↔user DMs)** — `dm_sender_keys`, `/keys` route, E2EE thread client, isE2ee selectable at creation.
- **E2EE bot DMs / "bot as crypto endpoint"** — `bot_key_bundles`, generalize `e2eeSenderKeys` to principals, lift the `isE2ee→400` block for DMs where the bot is a participant, SDK ECDH helpers. Largest remaining build; needs its own spec.
- **Bot-initiated DMs** — a bot can open a DM to a user (creates pending bot→user); user sees a request from the bot in the Requests bucket; bot replies disabled until accepted.
- **Inline keyboards in DMs** — needs an encryption story (currently jsonb plaintext on `messages.inline_keyboard`); ride with shop-bot work.
- **Bot blocking** — extend `dm_blocks` or add a parallel `dm_bot_blocks` so a user can mute a specific bot DM. Low priority; users can just stop replying.
- **Bot DM message edit/delete via API** — `editMessage`/`deleteMessage` route extensions for `conversationId`. Add when a real bot needs them.
- **Bot DM read receipts** — bot version of `/api/dm/[id]/read`. Probably not worth adding unless a bot needs it.
