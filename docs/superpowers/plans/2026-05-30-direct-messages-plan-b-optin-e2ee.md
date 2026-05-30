# Direct Messages — Plan B: Opt-in E2EE (user↔user)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a user↔user DM optionally end-to-end encrypted. The DM-local sender-key model reuses the existing E2EE primitives (`apps/web/lib/e2ee.ts`) and `userKeyBundles` pubkey registry, but lives in its own DM-only key distribution table — the shared `e2eeSenderKeys` (used by E2EE group topics) is NOT touched.

**Architecture:** A user picks "encrypted" at DM creation → `dm_conversations.isE2ee=true` (Plan A column, fixed at creation). The DM uses sender-key E2EE: each user generates a sender key, wraps it to the peer's identity public key (ECDH P-256 → AES-GCM), and stores it in the DM-local `dm_sender_keys` table. Messages are encrypted to the sender key as `{e:1,kid,iv,ct}` envelopes — the *plaintext* the server stores (and then at-rest-wraps via `@legends/crypto`) is the envelope. The client decrypts on render. TOFU pinning + safety numbers (already in `lib/e2ee.ts`) are reused.

**Tech Stack:** Drizzle ORM + Postgres, ioredis, zod, Next.js 15, browser WebCrypto (P-256 ECDH + AES-GCM-256), IndexedDB for identity + sender keys. Spec: `docs/superpowers/specs/2026-05-28-direct-messages-design.md`. Prior plans: A (`2026-05-28-…plaintext-core.md`), C (`2026-05-29-…plaintext-bot-dms.md`).

**Scope of Plan B (and what is NOT included):** Opt-in E2EE for user↔user DMs only. NO E2EE bot DMs (T6 of Plan C already rejects bot send to E2EE DM with "cannot send to E2EE DMs (plan B)" — it now means a future plan, not this one). NO key escrow or cross-device history transfer (inherit Plan A's "new device loses old history unless passkey-PRF restore" — same as the existing E2EE topic UX). NO rekey on member-removal (DM is 2-party; member set is fixed at creation). NO change to the existing E2EE group topic path or the shared `e2eeSenderKeys` table. NO inline keyboards / media (still plaintext-jsonb on the message row in Plan A, kept disallowed here).

---

## Test / verification strategy

Same as Plans A and C: `pnpm -r typecheck` (ignoring the pre-existing `packages/db/src/create-admin.ts` error); `pnpm --filter @legends/db test:run src/dm-key.test.ts` still passes; manual two-user browser smoke (the autonomous test harness from prior plans applies — `auth_login_tokens` + `/auth/callback`, two `isolatedContext` browser sessions). Live golden path: A opens an **encrypted** DM with B → B accepts → both sides send → both sides decrypt → A's display matches what was sent, server `dm_messages.contentCiphertext` is wrapped envelope (no plaintext readable after at-rest decrypt).

Commands: PATH includes `~/.npm-global/bin`. Web + ws dev servers run with `set -a; . ./.env; set +a` first (root `.env` has DB/Redis/JWT/encryption secrets; `apps/web/.env` lacks them).

---

## File structure

**Modify:**
- `packages/db/src/schema.ts` — add `dmSenderKeys` table.
- `packages/db/src/migrations/0037_dm_sender_keys.sql` (new) + `meta/_journal.json` entry.
- `apps/web/lib/dm.ts` — extend `openConversation` to accept `e2ee` flag; tighten so `e2ee=true` is rejected for bot peer.
- `apps/web/app/api/dm/route.ts` — pass `e2ee` from the open POST body.
- `apps/web/app/api/dm/[id]/messages/route.ts` — REMOVE the "e2ee send not supported in Plan A" 400 branch; allow user E2EE sends. (The Plan C bot route already rejects E2EE conv for bots — leave that.)
- `apps/web/components/DmClient.tsx` — E2EE thread support (encrypt before send, decrypt on render, sender-key cache + distribution + rotation, TOFU pin warnings), `🔒` indicator on E2EE conversations + thread header, "Encrypted" toggle in the new-DM search row.
- `apps/web/app/dm/page.tsx` — render `<E2EESetup>` gate if any conversation needs E2EE keys (or lazy-load inside `DmClient`).
- `apps/ws/src/index.ts` (or wherever push payloads are built for `notifyTopicMembers`/`dispatchMessageNotifications`-equivalent for DM) — push preview branches: E2EE DM → generic "New message". If the existing push builder for DMs doesn't exist yet, this becomes part of T7.

**Create:**
- `apps/web/app/api/dm/[id]/keys/route.ts` — GET fetch sender keys + peer pubkey; POST distribute sender keys.

**Untouched (by design):**
- `e2eeSenderKeys` (group topics' table) + the topic E2EE routes.
- `bots`, `bot_key_bundles` (doesn't exist — E2EE bot endpoint is a later plan).
- `dm_messages` schema, `dm_participants`, `dm_blocks`, `dm_conversations.isE2ee` column (already declared in Plan A).
- `lib/e2ee.ts` (reused as-is; no edits).
- `E2EESetup.tsx` / `E2EEKeyWarning.tsx` (reused as-is).

---

## Task 1: `dm_sender_keys` table + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0037_dm_sender_keys.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add the table to schema.ts**

Append to `packages/db/src/schema.ts` after the existing `dmBlocks` table (the imports `pgTable, uuid, text, integer, timestamp, uniqueIndex` are already present):

```ts
// ── Direct messages (1:1) — DM-local sender-key distribution (Plan B) ──────
export const dmSenderKeys = pgTable(
  "dm_sender_keys",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => dmConversations.id, { onDelete: "cascade" }),
    distributorUserId: uuid("distributor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    encryptedKey: text("encrypted_key").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("dm_sender_keys_pk").on(t.conversationId, t.distributorUserId, t.recipientUserId),
    convIdx: { name: "dm_sender_keys_conv_idx", columns: [t.conversationId] } as never, // see migration; index optional
  }),
);
```

(`as never` is a placeholder if drizzle's `index` import is needed — confirm it's already imported alongside `uniqueIndex/primaryKey` at the top of the file. If `index` isn't present, add it. The simplest form is just the `uniqueIndex` plus an optional secondary index in SQL; the drizzle declaration only needs to compile.)

- [ ] **Step 2: Hand-written migration SQL**

Create `packages/db/src/migrations/0037_dm_sender_keys.sql`:

```sql
-- Plan B: DM-local sender-key distribution (NOT touching e2ee_sender_keys for topics).
CREATE TABLE IF NOT EXISTS "dm_sender_keys" (
  "conversation_id" uuid NOT NULL REFERENCES "dm_conversations"("id") ON DELETE CASCADE,
  "distributor_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "recipient_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "encrypted_key" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dm_sender_keys_pk" PRIMARY KEY ("conversation_id", "distributor_user_id", "recipient_user_id")
);
CREATE INDEX IF NOT EXISTS "dm_sender_keys_conv_idx" ON "dm_sender_keys" ("conversation_id");
```

- [ ] **Step 3: Journal entry**

Append to `packages/db/src/migrations/meta/_journal.json` (last entry should be idx 36 from Plan C, `when: 1779700000000`):

```json
{
  "idx": 37,
  "version": "7",
  "when": 1779800000000,
  "tag": "0037_dm_sender_keys",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply + verify**

Controller runs:
- `pnpm db:migrate` → "migrations applied".
- `pnpm --filter @legends/db typecheck` → only the pre-existing `create-admin.ts` error.
- Verify table:
  ```
  pnpm --filter @legends/db exec tsx -e "import postgres from 'postgres'; const s=postgres(process.env.DATABASE_URL); console.log(await s\`select column_name, data_type from information_schema.columns where table_name='dm_sender_keys' order by ordinal_position\`); await s.end();"
  ```
  Expected rows: `conversation_id uuid, distributor_user_id uuid, recipient_user_id uuid, encrypted_key text, key_version integer, updated_at timestamp with time zone`.

---

## Task 2: `openConversation` accepts an `e2ee` flag (user↔user only)

**Files:**
- Modify: `apps/web/lib/dm.ts`
- Modify: `apps/web/app/api/dm/route.ts`

- [ ] **Step 1: Extend `openConversation` signature**

In `apps/web/lib/dm.ts`, change the `openConversation` signature to take an `options.e2ee` flag:

```ts
export async function openConversation(
  initiatorUserId: string,
  peer: { type: "user" | "bot"; id: string },
  options?: { e2ee?: boolean },
): Promise<{ id: string; created: boolean }> {
  if (peer.type === "user" && initiatorUserId === peer.id) throw Object.assign(new Error("cannot DM yourself"), { code: "BAD" });
  if (peer.type === "user" && (await isBlockedBetween(initiatorUserId, peer.id))) throw Object.assign(new Error("blocked"), { code: "BLOCKED" });
  if (peer.type === "bot") {
    if (options?.e2ee) throw Object.assign(new Error("e2ee bot DMs are not supported yet"), { code: "BAD" });
    const [b] = await db.select({ id: bots.id, dmEnabled: bots.dmEnabled, isActive: bots.isActive }).from(bots).where(eq(bots.id, peer.id)).limit(1);
    if (!b || !b.isActive || !b.dmEnabled) throw Object.assign(new Error("bot not dm-able"), { code: "BAD" });
  }
  const isE2ee = peer.type === "user" && !!options?.e2ee;

  const dmKey = buildDmKey({ type: "user", id: initiatorUserId }, peer);
  const existing = await db.select({ id: dmConversations.id, isE2ee: dmConversations.isE2ee }).from(dmConversations).where(eq(dmConversations.dmKey, dmKey)).limit(1);
  if (existing[0]) {
    // dmKey resolves to ONE conversation per pair. If the caller requested a
    // different e2ee mode than the existing thread, surface it as BAD — do
    // not silently downgrade or upgrade history.
    if (isE2ee !== existing[0].isE2ee) {
      throw Object.assign(new Error(`existing DM is ${existing[0].isE2ee ? "encrypted" : "plaintext"}; re-use that thread`), { code: "BAD" });
    }
    return { id: existing[0].id, created: false };
  }
  const state = peer.type === "bot" ? "accepted" : "pending";
  const [conv] = await db
    .insert(dmConversations)
    .values({ dmKey, isE2ee, state, initiatorType: "user", initiatorId: initiatorUserId })
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
```

The `openUserConversation` compat alias keeps its signature — pass through with no `options`.

- [ ] **Step 2: Update the POST `/api/dm` body schema**

In `apps/web/app/api/dm/route.ts`, change the open schema:

```ts
const openSchema = z.object({
  peerType: z.enum(["user", "bot"]),
  peerId: z.string().uuid(),
  e2ee: z.boolean().optional().default(false),
});
```

And pass it to `openConversation`:

```ts
const { id, created } = await openConversation(
  user.id,
  { type: parsed.data.peerType, id: parsed.data.peerId },
  { e2ee: parsed.data.e2ee },
);
```

- [ ] **Step 3: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` — clean.

---

## Task 3: DM-local key distribution route `/api/dm/[id]/keys`

**Files:**
- Create: `apps/web/app/api/dm/[id]/keys/route.ts`

- [ ] **Step 1: Implement GET + POST**

Create `apps/web/app/api/dm/[id]/keys/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { dmConversations, dmParticipants, dmSenderKeys, userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { assertParticipant } from "@/lib/dm";

async function userParticipantsOf(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ pid: dmParticipants.principalId })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.principalType, "user")));
  return rows.map((r) => r.pid);
}

// GET /api/dm/[id]/keys?distributorId=<userId>
// Returns the sender key the distributor wrapped FOR the caller, plus the
// distributor's identity public key. Mirrors the topic /api/topics/[id]/e2ee
// endpoint scoped to the DM subsystem.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try { await assertParticipant(id, user.id); } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }

  const [conv] = await db.select({ isE2ee: dmConversations.isE2ee }).from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv || !conv.isE2ee) return NextResponse.json({ error: "not an e2ee conversation" }, { status: 400 });

  const distributorId = req.nextUrl.searchParams.get("distributorId");
  if (!distributorId) {
    // Default: return the caller's view (all sender keys distributed TO me + peer pubkey + my membership list).
    const participants = await userParticipantsOf(id);
    const otherIds = participants.filter((u) => u !== user.id);
    const [keys, pubkeys] = await Promise.all([
      db
        .select({ distributorUserId: dmSenderKeys.distributorUserId, encryptedKey: dmSenderKeys.encryptedKey, keyVersion: dmSenderKeys.keyVersion })
        .from(dmSenderKeys)
        .where(and(eq(dmSenderKeys.conversationId, id), eq(dmSenderKeys.recipientUserId, user.id))),
      db
        .select({ userId: userKeyBundles.userId, identityPublicKey: userKeyBundles.identityPublicKey })
        .from(userKeyBundles)
        .where(inArray(userKeyBundles.userId, [user.id, ...otherIds])),
    ]);
    return NextResponse.json({ participants, otherIds, keys, pubkeys });
  }

  // Specific distributor: caller wants the sender key that <distributorId> distributed TO me.
  const [row] = await db
    .select({ encryptedKey: dmSenderKeys.encryptedKey, keyVersion: dmSenderKeys.keyVersion })
    .from(dmSenderKeys)
    .where(and(
      eq(dmSenderKeys.conversationId, id),
      eq(dmSenderKeys.distributorUserId, distributorId),
      eq(dmSenderKeys.recipientUserId, user.id),
    ))
    .limit(1);
  if (!row) return NextResponse.json({ error: "no key" }, { status: 404 });

  const [pk] = await db
    .select({ identityPublicKey: userKeyBundles.identityPublicKey })
    .from(userKeyBundles)
    .where(eq(userKeyBundles.userId, distributorId))
    .limit(1);
  return NextResponse.json({ encryptedKey: row.encryptedKey, keyVersion: row.keyVersion, distributorPublicKey: pk?.identityPublicKey ?? null });
}

const distributeSchema = z.object({
  // The caller's NEW sender key, wrapped per recipient.
  recipients: z.array(z.object({ userId: z.string().uuid(), encryptedKey: z.string().min(1) })).min(1),
  keyVersion: z.number().int().min(1).default(1),
});

// POST /api/dm/[id]/keys
// Caller (the distributor) uploads their sender key wrapped to every recipient.
// Upsert on (conversationId, distributorUserId=caller, recipientUserId).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try { await assertParticipant(id, user.id); } catch { return NextResponse.json({ error: "not found" }, { status: 404 }); }
  const parsed = distributeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const [conv] = await db.select({ isE2ee: dmConversations.isE2ee }).from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv || !conv.isE2ee) return NextResponse.json({ error: "not an e2ee conversation" }, { status: 400 });

  const participants = await userParticipantsOf(id);
  for (const r of parsed.data.recipients) {
    if (!participants.includes(r.userId)) {
      return NextResponse.json({ error: `recipient ${r.userId} is not a participant` }, { status: 400 });
    }
  }

  for (const r of parsed.data.recipients) {
    await db.insert(dmSenderKeys).values({
      conversationId: id,
      distributorUserId: user.id,
      recipientUserId: r.userId,
      encryptedKey: r.encryptedKey,
      keyVersion: parsed.data.keyVersion,
    }).onConflictDoUpdate({
      target: [dmSenderKeys.conversationId, dmSenderKeys.distributorUserId, dmSenderKeys.recipientUserId],
      set: { encryptedKey: r.encryptedKey, keyVersion: parsed.data.keyVersion, updatedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` — clean.

---

## Task 4: Lift the E2EE rejection in the user-side messages route

**Files:**
- Modify: `apps/web/app/api/dm/[id]/messages/route.ts`

- [ ] **Step 1: Remove the blanket 400**

In `apps/web/app/api/dm/[id]/messages/route.ts` POST, find and DELETE the line:

```ts
if (conv.isE2ee) return NextResponse.json({ error: "e2ee send not supported in Plan A" }, { status: 400 });
```

The server now treats text as opaque (it's the client-encrypted envelope when E2EE). The at-rest layer wraps it the same way regardless. No other change to insert/publish logic.

Note: the **bot** path in `apps/web/app/api/bot/v1/sendMessage/route.ts` keeps its `if (conv.isE2ee) ... "(plan B)"` rejection — bots still can't send to E2EE DMs without a bot keypair (deferred). Do NOT touch that branch.

- [ ] **Step 2: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` — clean.

---

## Task 5: DmClient — E2EE thread support

**Files:**
- Modify: `apps/web/components/DmClient.tsx`
- Maybe add: `apps/web/hooks/useDmE2EE.ts` (a focused hook that owns crypto state — preferred to bloating DmClient).

This is the biggest task. The client must: ensure the caller has identity keys; for each E2EE conversation it interacts with, fetch the peer's sender key (wrapped to me) on open; cache decrypted sender keys per-conversation in IndexedDB (mirror the topic path); generate + distribute its own sender key on first send and on session rotation; encrypt outgoing text as `{e:1, kid:<myUserId>, iv, ct}`; decrypt incoming messages.

- [ ] **Step 1: Sketch the hook**

Create `apps/web/hooks/useDmE2EE.ts`:

```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/fetch";
import {
  decryptE2EEMessage, decryptSenderKey, deriveSharedKey, encryptE2EEMessage,
  encryptSenderKeyForRecipient, generateSenderKey, getOrCreateIdentityKeyPair,
  getSenderKey, getSenderKeySessionId, importPublicKey, isE2EEContent,
  storeSenderKey, checkAndUpdatePin,
} from "@/lib/e2ee";
import { getOrCreateSessionId } from "@/lib/e2ee-session";

type PeerKey = { senderKey: Uint8Array; sessionId: string };

export type DmE2EE = {
  ready: boolean;
  needsSetup: boolean;
  myPubKeyB64: string | null;
  ensureReadyForConversation: (conversationId: string, peerUserId: string) => Promise<void>;
  encryptForConversation: (conversationId: string, peerUserId: string, plaintext: string) => Promise<string>;
  decryptFromConversation: (conversationId: string, fromUserId: string, envelopeText: string) => Promise<string | null>;
  keyWarning: { conversationId: string; peerUserId: string; oldFp: string; newFp: string } | null;
  trustNewKey: () => Promise<void>;
};

export function useDmE2EE(currentUserId: string): DmE2EE {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [myPubKeyB64, setMyPubKeyB64] = useState<string | null>(null);
  const keyPairRef = useRef<CryptoKeyPair | null>(null);
  const peerSenderKeysRef = useRef<Map<string, PeerKey>>(new Map()); // key: `${conversationId}:${userId}`
  const distributedRef = useRef<Set<string>>(new Set()); // conversationId-s where I've already distributed this session
  const [keyWarning, setKeyWarning] = useState<DmE2EE["keyWarning"]>(null);

  // Initial mount: ensure identity keypair + check server has my pubkey.
  useEffect(() => {
    (async () => {
      const kp = await getOrCreateIdentityKeyPair();
      keyPairRef.current = kp;
      const myPub = await crypto.subtle.exportKey("spki", kp.publicKey);
      const myPubB64 = btoa(String.fromCharCode(...new Uint8Array(myPub)));
      setMyPubKeyB64(myPubB64);

      // Reuse the topic registry: GET /api/user/keys
      const r = await apiFetch("/api/user/keys");
      if (r.status === 404) { setNeedsSetup(true); return; }
      if (!r.ok) return;
      const data = (await r.json()) as { identityPublicKey: string | null };
      if (!data.identityPublicKey) { setNeedsSetup(true); return; }
      if (data.identityPublicKey !== myPubB64) { setNeedsSetup(true); return; }
      setReady(true);
    })().catch(() => {});
  }, []);

  const ensureReadyForConversation = useCallback(async (conversationId: string, peerUserId: string) => {
    if (!keyPairRef.current) return;
    // Fetch the sender key that <peerUserId> distributed TO me, plus their pubkey.
    const r = await apiFetch(`/api/dm/${conversationId}/keys?distributorId=${peerUserId}`);
    if (r.status === 404) return; // peer hasn't distributed yet
    if (!r.ok) return;
    const data = (await r.json()) as { encryptedKey: string; keyVersion: number; distributorPublicKey: string | null };
    if (!data.distributorPublicKey) return;

    // TOFU pin check
    const pinResult = await checkAndUpdatePin(peerUserId, data.distributorPublicKey);
    if (pinResult.changed) {
      setKeyWarning({ conversationId, peerUserId, oldFp: pinResult.oldFingerprint!, newFp: pinResult.newFingerprint });
    }

    const peerPub = await importPublicKey(data.distributorPublicKey);
    const senderKey = await decryptSenderKey(data.encryptedKey, keyPairRef.current.privateKey, peerPub);
    const sessionId = getOrCreateSessionId();
    await storeSenderKey(conversationId, peerUserId, senderKey, sessionId);
    peerSenderKeysRef.current.set(`${conversationId}:${peerUserId}`, { senderKey, sessionId });
  }, []);

  const ensureMySenderKeyDistributed = useCallback(async (conversationId: string, peerUserId: string) => {
    if (distributedRef.current.has(conversationId)) return;
    if (!keyPairRef.current) return;

    // Fetch peer pubkey
    const r = await apiFetch("/api/user/keys?userId=" + peerUserId);
    if (!r.ok) throw new Error("peer has no keys yet");
    const data = (await r.json()) as { identityPublicKey: string | null };
    if (!data.identityPublicKey) throw new Error("peer has no keys yet");

    const senderKey = await generateSenderKey();
    const sessionId = getOrCreateSessionId();
    await storeSenderKey(conversationId, currentUserId, senderKey, sessionId);

    const peerPub = await importPublicKey(data.identityPublicKey);
    const wrapped = await encryptSenderKeyForRecipient(senderKey, keyPairRef.current.privateKey, peerPub);

    const dist = await apiFetch(`/api/dm/${conversationId}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipients: [{ userId: peerUserId, encryptedKey: wrapped }], keyVersion: 1 }),
    });
    if (!dist.ok) throw new Error("distribute failed");
    distributedRef.current.add(conversationId);
  }, [currentUserId]);

  const encryptForConversation = useCallback(async (conversationId: string, peerUserId: string, plaintext: string) => {
    await ensureMySenderKeyDistributed(conversationId, peerUserId);
    const my = await getSenderKey(conversationId, currentUserId);
    if (!my) throw new Error("my sender key missing after distribute");
    return encryptE2EEMessage(plaintext, currentUserId, my.senderKey);
  }, [currentUserId, ensureMySenderKeyDistributed]);

  const decryptFromConversation = useCallback(async (conversationId: string, fromUserId: string, envelopeText: string) => {
    if (!isE2EEContent(envelopeText)) return envelopeText;
    if (fromUserId === currentUserId) {
      const my = await getSenderKey(conversationId, currentUserId);
      if (!my) return null;
      return decryptE2EEMessage(envelopeText, my.senderKey);
    }
    let peer = peerSenderKeysRef.current.get(`${conversationId}:${fromUserId}`);
    if (!peer) {
      const fromIdb = await getSenderKey(conversationId, fromUserId);
      if (fromIdb) {
        peer = { senderKey: fromIdb.senderKey, sessionId: fromIdb.sessionId };
        peerSenderKeysRef.current.set(`${conversationId}:${fromUserId}`, peer);
      } else {
        await ensureReadyForConversation(conversationId, fromUserId);
        peer = peerSenderKeysRef.current.get(`${conversationId}:${fromUserId}`);
      }
    }
    if (!peer) return null;
    try { return await decryptE2EEMessage(envelopeText, peer.senderKey); } catch { return null; }
  }, [currentUserId, ensureReadyForConversation]);

  const trustNewKey = useCallback(async () => {
    if (!keyWarning) return;
    const { default: lib } = await import("@/lib/e2ee");
    await lib.confirmPinUpdate?.(keyWarning.peerUserId, keyWarning.newFp);
    setKeyWarning(null);
  }, [keyWarning]);

  return { ready, needsSetup, myPubKeyB64, ensureReadyForConversation, encryptForConversation, decryptFromConversation, keyWarning, trustNewKey };
}
```

NOTE: some helpers above (`deriveSharedKey`, `confirmPinUpdate`, `getOrCreateSessionId`, etc.) are real exports in `apps/web/lib/e2ee.ts` / `apps/web/lib/e2ee-session.ts` — when implementing, read those files first and use the actual exported names. Adjust the imports above to match reality. If a helper doesn't exist (e.g. PUBKEY base64 export helper), use whatever the existing topic-path code uses (search `TopicView.tsx` for `getOrCreateIdentityKeyPair` callsite and copy the pattern verbatim). The shape above is the intended interface; the exact API may need a one-line adjustment.

- [ ] **Step 2: Wire into DmClient**

In `apps/web/components/DmClient.tsx`:

1. Call the hook: `const e2ee = useDmE2EE(currentUserId);`
2. When opening an E2EE thread (`openThread(id)`), if the conv is E2EE: `await e2ee.ensureReadyForConversation(id, peerUserId)` and then decrypt the fetched messages individually:
   ```ts
   const decrypted = await Promise.all(
     d.messages.map(async (m) => {
       if (!conv.isE2ee) return m;
       const text = await e2ee.decryptFromConversation(id, m.senderId, m.text);
       return { ...m, text: text ?? "(decryption failed)" };
     }),
   );
   setMessages(decrypted);
   ```
3. In `send()` for an E2EE conv:
   ```ts
   const envelope = await e2ee.encryptForConversation(activeId, peerUserId, text);
   const r = await apiFetch(..., { body: JSON.stringify({ text: envelope }) });
   ```
   The optimistic 201 append must dedupe by id and run the decrypt on its own text too (or display the plaintext you just sent — simpler).
4. In the `useDmSocket` callback, if the new message belongs to an E2EE conv, decrypt it before append.
5. Render `🔒` next to the peer name in the accepted list and in the thread header for E2EE conversations.
6. If `e2ee.needsSetup`, render the existing `<E2EESetup />` component (the same one TopicView uses) as a gate before the thread. After setup, `e2ee.ready` flips to true.
7. If `e2ee.keyWarning` is set, render `<E2EEKeyWarning />` (existing component) above the thread with a "Trust new key" action calling `e2ee.trustNewKey()`.

- [ ] **Step 3: Typecheck + manual smoke**

`pnpm --filter @legends/web typecheck` clean. Manual two-user smoke with the controller's existing autonomous browser harness:
- A opens an **Encrypted** DM with B (e2ee toggle in the new-DM row — see Task 7).
- B accepts (E2EESetup runs if B had no keys — confirm passkey-PRF backup prompt appears for non-anon).
- A sends "hi over e2ee".
- DB check (controller): `select content_ciphertext from dm_messages where conversation_id = '<id>' limit 1` — when at-rest-decrypted, the value should be a JSON envelope starting with `{"e":1,`, not plaintext.
- B's browser shows the decrypted text.
- A's lock icon visible on the conversation row + thread header.

---

## Task 6: New-DM E2EE toggle + lock indicator

**Files:**
- Modify: `apps/web/components/DmClient.tsx`

- [ ] **Step 1: Toggle next to the search results**

Add a small "Encrypted" toggle (default off) next to the search input, in scope for user peers only:

```tsx
const [requestE2EE, setRequestE2EE] = useState(false);
// ... in the aside, below the search input:
<label className="flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" checked={requestE2EE} onChange={(e) => setRequestE2EE(e.target.checked)} />
  Encrypted (user-to-user only)
</label>
```

And update `startDm(peer)`:

```ts
async function startDm(peer: SearchHit) {
  const wantE2EE = requestE2EE && peer.type === "user";
  const r = await apiFetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerType: peer.type, peerId: peer.id, e2ee: wantE2EE }) });
  if (!r.ok) { const err = (await r.json()) as { error?: string }; alert(err.error ?? "could not open DM"); return; }
  const d = (await r.json()) as { id: string };
  setQuery(""); setHits([]); setRequestE2EE(false);
  await refreshList();
  await openThread(d.id);
}
```

- [ ] **Step 2: Lock indicator**

In the accepted-conversations list, add a `🔒` after the peer name when `c.isE2ee`:

```tsx
<span className="truncate">{c.peer?.displayName ?? "Unknown"}</span>
{c.isE2ee && <span aria-label="encrypted" title="end-to-end encrypted">🔒</span>}
{c.peer?.type === "bot" && <span className="ml-auto rounded ...">bot</span>}
```

(Place the lock between the name and any trailing badge.)

Add the same `🔒` in the mobile thread header next to the Back button or peer name (if/when added).

- [ ] **Step 3: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` — clean.

---

## Task 7: Push preview branches on `isE2ee`

**Files:**
- Modify: the push notification builder for DMs.

Plan A did NOT wire push notifications for DMs (Plan A's "Deferred" section). If push for DM hasn't been added yet, this task is effectively "when adding DM push, branch on `isE2ee` and use a generic preview when true." If DM push doesn't exist, mark the task complete with a one-line note in the codebase (TODO comment near the existing topic push code) explaining the intent — don't bolt on DM push as part of Plan B.

- [ ] **Step 1: Detect existing DM push code path**

Grep: `rg "DM_MESSAGE_NEW|dispatchMessageNotifications|notifyTopicMembers" apps/web apps/ws`. If a DM push builder exists, modify it: when `isE2ee`, set the `body` of the web-push payload to a generic string like `"New message"`; otherwise use the truncated text. If no DM push builder exists yet, add a TODO comment at the call site of the analogous topic helper noting Plan B's requirement, and move on.

- [ ] **Step 2: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` (and `@legends/ws` if you touched it) — clean.

---

## Self-review checklist (before declaring Plan B done)

- [ ] `pnpm -r typecheck` clean (excluding the pre-existing `create-admin.ts` error).
- [ ] `pnpm --filter @legends/db test:run src/dm-key.test.ts` still passes.
- [ ] Migration 0037 applied; `dm_sender_keys` exists with the listed columns + composite PK + index.
- [ ] Open an encrypted DM (Plan B path) → server `dm_messages.content_ciphertext`, once at-rest-decrypted, is a `{"e":1,...}` envelope (not plaintext).
- [ ] Plain (Plan A) and bot (Plan C) flows still work: regression-check by sending a user↔user plaintext DM and a user→bot plaintext DM and confirming both round-trip + render unchanged.
- [ ] Spec coverage: `dm_sender_keys` (T1), e2ee flag at creation (T2/T3), DM-local key distribute/fetch (T3), E2EE send path open (T4), client encrypt/decrypt + TOFU (T5), UI toggle + lock indicator (T6), push generic preview when E2EE (T7).
- [ ] NO writes to `e2eeSenderKeys` (the group topics table). NO changes to `lib/e2ee.ts`. NO bot E2EE work.

---

## Deferred to later plans

- **E2EE bot DMs / bot-as-crypto-endpoint** — `bot_key_bundles` registry, lift the `isE2ee→400` in `/api/bot/v1/sendMessage` for DMs where the bot is a participant, SDK-side ECDH wrap/unwrap. Spec section 2 of the design doc.
- **Switching an existing DM between plaintext and E2EE** — fixed at creation; explicit error if caller re-opens with a different mode (handled in T2).
- **Multi-device cross-device history transfer for DMs** — same limitation as topic E2EE today (passkey-PRF restore only).
- **Inline keyboards and media in DMs** — still disallowed (plaintext jsonb on the message row would leak).
- **TOFU UX polish** — verify QR codes / safety-number export for DMs (`computeSafetyNumber` exists for topics; surfacing it in DmClient is follow-up).
- **Rekey-on-member-removal** — N/A for 1:1; revisit only if/when group DMs become a thing.
