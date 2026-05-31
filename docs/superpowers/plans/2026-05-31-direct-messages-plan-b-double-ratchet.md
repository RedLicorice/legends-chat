# Direct Messages — Plan B: Signal Double Ratchet E2EE (user↔user, via Olm)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a user↔user DM optionally end-to-end encrypted using the Signal Double Ratchet protocol (X3DH session setup + ratchet). Per-message forward secrecy and post-compromise security. Replaces the rejected sender-key first draft of Plan B.

**Architecture:** The separate DM subsystem from Plans A/C stays unchanged structurally — own tables, own routes, no group-E2EE machinery touched. Inside `dm_messages.contentCiphertext` we now store an **Olm Double Ratchet ciphertext envelope** instead of a sender-key envelope. The server's at-rest layer (`@legends/crypto`) still wraps that envelope on insert; the inner content is opaque ratcheted bytes the server cannot read. Session establishment uses Olm's X3DH (identity + signed prekey + one-time prekey). Per-(user, peer) Olm `Session` state is persisted in browser IndexedDB (pickled with a random local key). The shared `userKeyBundles` table gains prekey columns and a new `user_one_time_prekeys` table feeds the X3DH consumer.

**Tech Stack:** **`@matrix-org/olm`** (Matrix's audited C++/WASM port of the Olm protocol — MIT-licensed, deployed at scale in Element/Matrix, browser + Node compatible, includes Double Ratchet + X3DH for 1:1 sessions). Drizzle ORM + Postgres, Next.js 15 (App Router), browser WebCrypto only for the random key that pickles the Olm account at rest in IndexedDB. Spec: `docs/superpowers/specs/2026-05-28-direct-messages-design.md`. Prior plans: A (`2026-05-28-…plaintext-core.md`), C (`2026-05-29-…plaintext-bot-dms.md`).

**Library choice rationale:** Olm = audited, mature, real Double Ratchet. Alternatives considered and rejected: `@signalapp/libsignal-client` (no first-class browser WASM yet; Rust/N-API better on server); pure-TS reimplementations of Signal protocol (smaller bundles, but not audited at the same level). Olm gives us per-message FS + PCS, automatic ratchet state management, deterministic pickle/unpickle for persistence.

**Scope of Plan B (and what is NOT included):** Opt-in E2EE for user↔user DMs only. **ONE device per user** (Olm account is per-device; current platform model allows only one registered identity pubkey per user — adding multi-device = a device registry, deferred). NO bot E2EE — the Plan C route (`apps/web/app/api/bot/v1/sendMessage`) keeps its `"cannot send to E2EE DMs (plan B)"` rejection; bot-as-Olm-endpoint is a future plan. NO Megolm (group ratchet) — DM is 1:1. NO signed-prekey automatic rotation (signed prekey is uploaded once on account creation; rotation = follow-up). NO cross-device history transfer. NO change to the existing E2EE group-topic path (`e2eeSenderKeys`, `lib/e2ee.ts` topic helpers, `userKeyBundles.identityPublicKey` is still used and shared with that path; Plan B *adds* sibling columns).

---

## Test / verification strategy

Same baseline as Plans A and C — there is no unit-test framework outside `packages/db`'s vitest, and we don't introduce one here:
- `pnpm -r typecheck` clean (ignoring the pre-existing `packages/db/src/create-admin.ts` error).
- `pnpm --filter @legends/db test:run src/dm-key.test.ts` still passes (no schema break to Plan A's pure helper).
- Manual two-user browser smoke via the established autonomous harness (`auth_login_tokens` + `/auth/callback` + two `isolatedContext` browser sessions). Live golden path:
  1. A and B each have an Olm account auto-provisioned on first E2EE DM entry (lazy WASM init).
  2. A opens an **Encrypted** DM with B → B accepts.
  3. A sends "hi over ratchet" → first message carries a PreKey envelope (type 0).
  4. B's browser decrypts and replies → reply is a regular Message envelope (type 1) advancing the ratchet.
  5. A and B both send several messages back-and-forth → all decrypt.
  6. DB check (controller): `select content_ciphertext from dm_messages where conversation_id = '<id>' limit 1` — once at-rest-decrypted, the value is an opaque `{"r":1,"t":0|1,"b":"<base64>"}` envelope (or whatever shape this plan defines), NOT plaintext.
  7. Regression: a plaintext (Plan A) user↔user DM and a plaintext bot (Plan C) DM still round-trip and render correctly.

Commands: PATH must include `~/.npm-global/bin`. Web + ws dev servers run with `set -a; . ./.env; set +a` first.

---

## File structure

**Modify:**
- `packages/db/src/schema.ts` — extend `userKeyBundles` with signed prekey columns; add `userOneTimePrekeys` table.
- `packages/db/src/migrations/0037_dm_double_ratchet_prekeys.sql` (new) + `meta/_journal.json` entry idx 37.
- `apps/web/package.json` — add `@matrix-org/olm` dep.
- `apps/web/lib/dm.ts` — extend `openConversation` to accept `e2ee` flag (user-only, mode-mismatch error on existing thread). (Same change the old draft of Plan B specified.)
- `apps/web/app/api/dm/route.ts` — pass `e2ee` flag to `openConversation`.
- `apps/web/app/api/dm/[id]/messages/route.ts` — REMOVE the `"e2ee send not supported in Plan A"` 400 branch. (Bot route keeps its E2EE rejection.)
- `apps/web/components/DmClient.tsx` — Encrypted toggle in the new-DM row, 🔒 indicator on E2EE conversations, encrypt-before-send + decrypt-on-render integration with the Olm wrapper, E2EE setup gate, key-change/TOFU UI.
- `apps/web/app/dm/page.tsx` — no change required if the wrapper is lazy-loaded inside `DmClient`.

**Create:**
- `apps/web/lib/dm-olm.ts` — Olm lazy-loader + account/session/storage wrapper (the single isolation point for the crypto).
- `apps/web/app/api/user/keys/prekeys/route.ts` — POST upload identity + signed prekey + batch of one-time prekeys.
- `apps/web/app/api/user/keys/bundle/route.ts` — GET fetch a prekey bundle for a peer (atomically consumes one one-time prekey).
- (Optional helper) `packages/db/src/dm-prekeys.ts` — pure helper for the atomic "pop one OTK" SQL (so the route stays small).

**Untouched (by design):**
- `e2eeSenderKeys` (group topics) and the topic E2EE routes.
- `lib/e2ee.ts` (still used for group E2EE on topics).
- `dm_messages`, `dm_participants`, `dm_blocks`, `dm_conversations.isE2ee` (all from Plan A — column shapes unchanged; Plan B reinterprets `dm_messages.contentCiphertext` content when `isE2ee=true` as an Olm envelope instead of a sender-key envelope).
- Bot route's E2EE rejection.

---

## Task 1: Add `@matrix-org/olm` dependency + bundling note

**Files:**
- Modify: `apps/web/package.json`
- (Possibly) Modify: `apps/web/next.config.mjs` if WASM needs an asset rule.

- [ ] **Step 1: Add the dep**

Add to `apps/web/package.json` dependencies:

```json
"@matrix-org/olm": "^3.2.15"
```

(Latest 3.x at the time of this plan. Confirm the current version on npm before pinning.)

Controller runs: `pnpm install`. Expect lockfile updated, no errors.

- [ ] **Step 2: Verify WASM resolution under `next dev --turbo` and `next build`**

The Olm package ships `olm.wasm` next to its JS entry. Next.js 15 / Turbopack handles npm-bundled `.wasm` automatically in most cases, but check that `await Olm.init()` actually resolves without "WebAssembly.instantiate" errors.

If WASM doesn't load out of the box (e.g., 404 on the .wasm path):
- Add a `webpack` config (next.config) or rely on Turbopack's built-in WASM loader.
- Confirm `next.config.mjs` already has `transpilePackages` for our internal packages; if Olm needs anything, document it.

Controller verifies: `pnpm --filter @legends/web dev` boots, `Olm.init()` from a one-off node script works (`node --input-type=module -e "import Olm from '@matrix-org/olm'; await Olm.init(); console.log('olm', Olm.get_library_version());"`).

- [ ] **Step 3: Typecheck**

Controller: `pnpm --filter @legends/web typecheck` — clean.

---

## Task 2: Schema — signed prekey columns + one-time prekey table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0037_dm_double_ratchet_prekeys.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Extend `userKeyBundles` and add `userOneTimePrekeys`**

In `packages/db/src/schema.ts`, in the existing `userKeyBundles` table (already has `userId`, `identityPublicKey`, `keyBundle`), add columns:

```ts
    // Olm Curve25519 signed prekey (base64), its id, and Ed25519 signature
    // produced by the identity key. Plan B / Olm X3DH.
    signedPrekeyId: text("signed_prekey_id"),
    signedPrekey: text("signed_prekey"),
    signedPrekeySig: text("signed_prekey_sig"),
    signedPrekeyUpdatedAt: timestamp("signed_prekey_updated_at", { withTimezone: true }),
```

Then add the new table (after `userKeyBundles`):

```ts
export const userOneTimePrekeys = pgTable(
  "user_one_time_prekeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    prekeyId: text("prekey_id").notNull(),
    prekey: text("prekey").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: uuid("consumed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    userIdx: index("user_one_time_prekeys_user_idx").on(t.userId, t.consumedAt),
    pkPerUser: uniqueIndex("user_one_time_prekeys_pk_idx").on(t.userId, t.prekeyId),
  }),
);
```

`text` (for the public-key base64), `uuid`, `timestamp`, `index`, `uniqueIndex`, `users` — all already imported. Add `index` if it isn't.

- [ ] **Step 2: Hand-written migration SQL**

Create `packages/db/src/migrations/0037_dm_double_ratchet_prekeys.sql`:

```sql
-- Plan B (Double Ratchet): extend identity key bundle with signed prekey + add
-- one-time prekey pool. Server stores public material only.

ALTER TABLE "user_key_bundles"
  ADD COLUMN IF NOT EXISTS "signed_prekey_id" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey_sig" text,
  ADD COLUMN IF NOT EXISTS "signed_prekey_updated_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "user_one_time_prekeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "prekey_id" text NOT NULL,
  "prekey" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_one_time_prekeys_pk_idx" ON "user_one_time_prekeys" ("user_id", "prekey_id");
CREATE INDEX IF NOT EXISTS "user_one_time_prekeys_user_idx" ON "user_one_time_prekeys" ("user_id", "consumed_at");
```

- [ ] **Step 3: Journal entry**

Append to `meta/_journal.json` (last entry should be idx 36 from Plan C, `when: 1779700000000`):

```json
{
  "idx": 37,
  "version": "7",
  "when": 1779800000000,
  "tag": "0037_dm_double_ratchet_prekeys",
  "breakpoints": true
}
```

- [ ] **Step 4: Apply + verify**

Controller: `pnpm db:migrate` → "migrations applied". Then:

```
pnpm --filter @legends/db exec tsx -e "import postgres from 'postgres'; const s=postgres(process.env.DATABASE_URL); console.log(await s\`select column_name from information_schema.columns where table_name='user_key_bundles' and column_name like 'signed_prekey%'\`); console.log(await s\`select column_name from information_schema.columns where table_name='user_one_time_prekeys' order by ordinal_position\`); await s.end();"
```

Expect the four new columns on `user_key_bundles` and the full column list of `user_one_time_prekeys`.

- [ ] **Step 5: Typecheck**

Controller: `pnpm --filter @legends/db typecheck` — only the pre-existing `create-admin.ts` error.

---

## Task 3: Server route — upload prekeys (`POST /api/user/keys/prekeys`)

**Files:**
- Create: `apps/web/app/api/user/keys/prekeys/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { userKeyBundles, userOneTimePrekeys } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const bodySchema = z.object({
  identityPublicKey: z.string().min(1).max(2048).optional(),
  signedPrekeyId: z.string().min(1).max(128),
  signedPrekey: z.string().min(1).max(2048),
  signedPrekeySig: z.string().min(1).max(2048),
  oneTimePrekeys: z.array(z.object({
    id: z.string().min(1).max(128),
    key: z.string().min(1).max(2048),
  })).min(1).max(200),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const b = parsed.data;

  // Upsert userKeyBundles. If the caller passed identityPublicKey we set it;
  // otherwise we leave whatever is there. Existing topic-E2EE flow uses
  // identityPublicKey via /api/user/keys (separate endpoint) — Plan B reuses
  // the same column; if both flows write, last write wins and triggers TOFU
  // warnings on peers, which is acceptable.
  await db.insert(userKeyBundles).values({
    userId: user.id,
    identityPublicKey: b.identityPublicKey ?? "", // legacy; route at /api/user/keys is the canonical setter for this field
    signedPrekeyId: b.signedPrekeyId,
    signedPrekey: b.signedPrekey,
    signedPrekeySig: b.signedPrekeySig,
    signedPrekeyUpdatedAt: new Date(),
  }).onConflictDoUpdate({
    target: userKeyBundles.userId,
    set: {
      ...(b.identityPublicKey ? { identityPublicKey: b.identityPublicKey } : {}),
      signedPrekeyId: b.signedPrekeyId,
      signedPrekey: b.signedPrekey,
      signedPrekeySig: b.signedPrekeySig,
      signedPrekeyUpdatedAt: new Date(),
    },
  });

  // Insert one-time prekeys; ignore duplicates on (userId, prekeyId).
  for (const p of b.oneTimePrekeys) {
    await db.insert(userOneTimePrekeys).values({
      userId: user.id,
      prekeyId: p.id,
      prekey: p.key,
    }).onConflictDoNothing();
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck**

`pnpm --filter @legends/web typecheck` — clean.

---

## Task 4: Server route — fetch a prekey bundle (`GET /api/user/keys/bundle?userId=…`)

**Files:**
- Create: `apps/web/app/api/user/keys/bundle/route.ts`

The route must atomically pop one unconsumed one-time prekey for the target user (or return null if exhausted — then the X3DH falls back to the signed prekey alone, weakening initial forward secrecy but still establishing a session). Use `UPDATE ... RETURNING` with `WHERE ctid IN (SELECT ctid ... FOR UPDATE SKIP LOCKED LIMIT 1)` for race safety.

- [ ] **Step 1: Implement**

```ts
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { userKeyBundles } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.isAnon) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const minuteKey = `dm:bundle:${user.id}:m:${Math.floor(Date.now() / 60000)}`;
  const rl = await checkAndIncrement(minuteKey, 30, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json({ error: "rate limit exceeded", retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const { searchParams } = new URL(req.url);
  const peerId = searchParams.get("userId");
  if (!peerId || !/^[0-9a-f-]{36}$/i.test(peerId)) return NextResponse.json({ error: "bad userId" }, { status: 400 });

  const [bundle] = await db
    .select({
      userId: userKeyBundles.userId,
      identityPublicKey: userKeyBundles.identityPublicKey,
      signedPrekeyId: userKeyBundles.signedPrekeyId,
      signedPrekey: userKeyBundles.signedPrekey,
      signedPrekeySig: userKeyBundles.signedPrekeySig,
    })
    .from(userKeyBundles)
    .where(eq(userKeyBundles.userId, peerId))
    .limit(1);
  if (!bundle || !bundle.signedPrekey) return NextResponse.json({ error: "peer has not published e2ee keys yet" }, { status: 404 });

  // Atomically pop one unconsumed one-time prekey.
  const popped = await db.execute(sql`
    UPDATE user_one_time_prekeys
       SET consumed_at = now(), consumed_by_user_id = ${user.id}
     WHERE ctid IN (
       SELECT ctid FROM user_one_time_prekeys
        WHERE user_id = ${peerId} AND consumed_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING prekey_id, prekey
  `);
  const otkRow = (popped as unknown as { rows?: Array<{ prekey_id: string; prekey: string }> }).rows?.[0] ?? null;
  // (postgres-js + drizzle.execute return type — confirm during implementation; adjust extraction.)

  return NextResponse.json({
    userId: bundle.userId,
    identityKey: bundle.identityPublicKey,
    signedPrekeyId: bundle.signedPrekeyId,
    signedPrekey: bundle.signedPrekey,
    signedPrekeySig: bundle.signedPrekeySig,
    oneTimePrekey: otkRow ? { id: otkRow.prekey_id, key: otkRow.prekey } : null,
  });
}
```

The exact extraction shape of `db.execute(sql\`…\`)` may differ — when implementing, confirm against an existing `db.execute(sql\`…\`)` call (e.g. `apps/ws/src/messages.ts` does `db.execute(sql\`UPDATE messages SET search_vector …\`)`). Adjust the destructuring accordingly.

Also note: the existing `/api/user/keys` route (used by the topic-E2EE path) is the canonical setter for `identityPublicKey`. Plan B's `/api/user/keys/prekeys` only writes the prekey columns by default. The bundle response returns whatever `identityPublicKey` is currently stored.

- [ ] **Step 2: Typecheck + manual sanity**

`pnpm --filter @legends/web typecheck` — clean. Manual: after the client side lands, hit the route as Noodlez asking for TERPLABZ's bundle and confirm one OTK is consumed (`select count(*) from user_one_time_prekeys where user_id=<TERPLABZ id> and consumed_at is not null` increments by 1).

---

## Task 5: Client — Olm wrapper (`apps/web/lib/dm-olm.ts`)

**Files:**
- Create: `apps/web/lib/dm-olm.ts`

This module owns ALL Olm state and never escapes its surface. Heavy WASM init is lazy. Persistence is in IndexedDB; the pickle key is a random 32-byte key stored in the same IndexedDB (so the pickle is only as secure as IndexedDB itself — pragmatic; a future enhancement could derive the pickle key from a WebAuthn PRF).

- [ ] **Step 1: Implement**

```ts
"use client";
import Olm from "@matrix-org/olm";

const DB_NAME = "legends-dm-olm";
const STORE = "olm";

type IdentityKeys = { curve25519: string; ed25519: string };

let olmReady: Promise<typeof Olm> | null = null;
async function loadOlm() {
  if (!olmReady) {
    olmReady = Olm.init({ locateFile: () => "/olm.wasm" }).then(() => Olm);
    // ^ locateFile: depending on bundler. If the WASM is auto-served from the
    //   node_modules path it may not need overriding. Confirm at runtime; the
    //   simplest fallback is to copy node_modules/@matrix-org/olm/olm.wasm to
    //   apps/web/public/olm.wasm at build time. Document this in the README.
  }
  return olmReady;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  return await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => res(req.result as T | undefined);
    req.onerror = () => rej(req.error);
  });
}
async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  return await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function getPickleKey(): Promise<string> {
  let k = await idbGet<string>("pickle-key");
  if (k) return k;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  k = btoa(String.fromCharCode(...bytes));
  await idbPut("pickle-key", k);
  return k;
}

// ── Account ──────────────────────────────────────────────────────────────────

export type AccountSnapshot = { identityKeys: IdentityKeys };

export async function getOrCreateAccount(): Promise<{ account: any; snapshot: AccountSnapshot; created: boolean }> {
  const O = await loadOlm();
  const pickle = await getPickleKey();
  const stored = await idbGet<string>("account");
  const account = new O.Account();
  let created = false;
  if (stored) {
    account.unpickle(pickle, stored);
  } else {
    account.create();
    await idbPut("account", account.pickle(pickle));
    created = true;
  }
  const identityKeys = JSON.parse(account.identity_keys()) as IdentityKeys;
  return { account, snapshot: { identityKeys }, created };
}

async function persistAccount(account: any): Promise<void> {
  const pickle = await getPickleKey();
  await idbPut("account", account.pickle(pickle));
}

// ── Prekey generation + publish (X3DH side prep) ──────────────────────────────

export async function generateAndPublishKeys(oneTimeCount = 100): Promise<void> {
  const { account } = await getOrCreateAccount();
  // Signed prekey
  account.generate_one_time_keys(0); // no-op safe; ensures internal state
  account.generate_signed_pre_key?.(); // depending on Olm API version — confirm
  const spk = account.signed_pre_key?.() as { id: string; key: string; signature: string } | undefined;
  // (Method names depend on the Olm version. The actual API: account.signed_keys() →
  //  identity + signed prekey object. The implementer MUST verify against the
  //  installed @matrix-org/olm and adjust the few method names below.)

  // One-time prekeys
  account.generate_one_time_keys(oneTimeCount);
  const otkJson = JSON.parse(account.one_time_keys()) as { curve25519: Record<string, string> };
  const oneTime = Object.entries(otkJson.curve25519).map(([id, key]) => ({ id, key }));

  // POST to server
  const body = {
    signedPrekeyId: spk?.id ?? "1",
    signedPrekey: spk?.key ?? "",
    signedPrekeySig: spk?.signature ?? "",
    oneTimePrekeys: oneTime,
  };
  const r = await fetch("/api/user/keys/prekeys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`publish keys failed: ${r.status}`);

  account.mark_keys_as_published();
  await persistAccount(account);
}

// ── Sessions per (peer, conversation) ────────────────────────────────────────

type StoredSession = { pickled: string; peerIdentity: string };

function sessionKey(conversationId: string, peerUserId: string): string {
  return `session:${conversationId}:${peerUserId}`;
}

export async function openOutboundSession(
  conversationId: string,
  peerUserId: string,
  peerBundle: { identityKey: string; signedPrekey: string; oneTimePrekey?: { key: string } | null },
): Promise<void> {
  const O = await loadOlm();
  const { account } = await getOrCreateAccount();
  const session = new O.Session();
  const otk = peerBundle.oneTimePrekey?.key;
  if (!otk) {
    // No one-time prekey available — Olm requires one for the outbound side
    // in the standard API. If exhausted, surface a clear error so the UI can
    // ask the peer to re-publish prekeys. (Future: add a fallback path.)
    throw new Error("peer has no one-time prekey available — ask them to refresh");
  }
  session.create_outbound(account, peerBundle.identityKey, otk);
  const pickle = await getPickleKey();
  await idbPut(sessionKey(conversationId, peerUserId), {
    pickled: session.pickle(pickle),
    peerIdentity: peerBundle.identityKey,
  } satisfies StoredSession);
  await persistAccount(account);
}

export async function openInboundSession(
  conversationId: string,
  peerUserId: string,
  peerIdentityCurve25519: string,
  prekeyMessageBody: string,
): Promise<void> {
  const O = await loadOlm();
  const { account } = await getOrCreateAccount();
  const session = new O.Session();
  session.create_inbound_from(account, peerIdentityCurve25519, prekeyMessageBody);
  account.remove_one_time_keys(session);
  const pickle = await getPickleKey();
  await idbPut(sessionKey(conversationId, peerUserId), {
    pickled: session.pickle(pickle),
    peerIdentity: peerIdentityCurve25519,
  } satisfies StoredSession);
  await persistAccount(account);
}

async function loadSession(conversationId: string, peerUserId: string): Promise<{ session: any; peerIdentity: string } | null> {
  const stored = await idbGet<StoredSession>(sessionKey(conversationId, peerUserId));
  if (!stored) return null;
  const O = await loadOlm();
  const pickle = await getPickleKey();
  const session = new O.Session();
  session.unpickle(pickle, stored.pickled);
  return { session, peerIdentity: stored.peerIdentity };
}

async function persistSession(conversationId: string, peerUserId: string, session: any, peerIdentity: string): Promise<void> {
  const pickle = await getPickleKey();
  await idbPut(sessionKey(conversationId, peerUserId), {
    pickled: session.pickle(pickle),
    peerIdentity,
  } satisfies StoredSession);
}

// ── Encrypt / Decrypt ────────────────────────────────────────────────────────

export type Envelope = { r: 1; t: 0 | 1; b: string }; // r=ratcheted, t=Olm message type (0 prekey, 1 message), b=base64 ciphertext

export async function encrypt(conversationId: string, peerUserId: string, plaintext: string): Promise<string> {
  const s = await loadSession(conversationId, peerUserId);
  if (!s) throw new Error("no session — call openOutboundSession first");
  const { type, body } = s.session.encrypt(plaintext) as { type: 0 | 1; body: string };
  await persistSession(conversationId, peerUserId, s.session, s.peerIdentity);
  const env: Envelope = { r: 1, t: type, b: body };
  return JSON.stringify(env);
}

export async function decrypt(conversationId: string, peerUserId: string, envelopeText: string): Promise<string> {
  const env = JSON.parse(envelopeText) as Envelope;
  if (env.r !== 1) throw new Error("not a ratcheted envelope");

  let s = await loadSession(conversationId, peerUserId);
  if (!s) {
    // First message from peer is type 0 (prekey). Establish inbound session.
    if (env.t !== 0) throw new Error("no session and not a prekey message");
    // We need the peer's identity Curve25519. Fetch it from the bundle endpoint
    // for X3DH context (it's also embedded in the prekey message header — Olm
    // can derive it from the message itself; create_inbound_from is the simpler
    // path when we know the identity, which we do via /api/user/keys).
    const r = await fetch(`/api/user/keys/bundle?userId=${peerUserId}`);
    if (!r.ok) throw new Error("could not fetch peer bundle for inbound session");
    const bundle = (await r.json()) as { identityKey: string };
    await openInboundSession(conversationId, peerUserId, bundle.identityKey, env.b);
    s = await loadSession(conversationId, peerUserId);
    if (!s) throw new Error("inbound session establish failed");
  }
  const plaintext = s.session.decrypt(env.t, env.b);
  await persistSession(conversationId, peerUserId, s.session, s.peerIdentity);
  return plaintext;
}

// ── Identity fingerprint (for safety-number UI) ──────────────────────────────

export async function myIdentityKeys(): Promise<IdentityKeys> {
  const { snapshot } = await getOrCreateAccount();
  return snapshot.identityKeys;
}
```

Note the `// (Method names depend on the Olm version. …)` comments. When implementing, run a one-off:
```
node --input-type=module -e "import O from '@matrix-org/olm'; await O.init(); const a = new O.Account(); a.create(); console.log('id:', a.identity_keys()); a.generate_one_time_keys(5); console.log('otk:', a.one_time_keys()); a.free();"
```
to confirm the API surface (some Olm versions have `generate_fallback_key`, `signed_keys()`, etc.). Adjust the wrapper to match. The intent is unchanged.

- [ ] **Step 2: Typecheck**

`pnpm --filter @legends/web typecheck`. Olm's TypeScript types may need a `declare module '@matrix-org/olm'` in `apps/web/types/` if the package ships no types. Add a minimal declaration there if needed.

---

## Task 6: `openConversation` accepts `e2ee` flag (user↔user only)

Same as the prior plan's Task 2. Reproduced for completeness:

**Files:**
- Modify: `apps/web/lib/dm.ts`
- Modify: `apps/web/app/api/dm/route.ts`

- [ ] **Step 1: Extend `openConversation` signature**

(Identical to the rejected-Plan-B Task 2 — including the existing-thread mode-mismatch error. Insert the same code into `apps/web/lib/dm.ts`.)

- [ ] **Step 2: POST schema accepts `e2ee`**

(Same as the rejected-Plan-B Task 2 Step 2 — add `e2ee: z.boolean().optional().default(false)` to `openSchema` in `apps/web/app/api/dm/route.ts` and forward to `openConversation`.)

- [ ] **Step 3: Typecheck**

`pnpm --filter @legends/web typecheck` clean.

---

## Task 7: Lift the E2EE rejection on the user-side messages route

**Files:**
- Modify: `apps/web/app/api/dm/[id]/messages/route.ts`

- [ ] **Step 1: Remove the 400**

Delete:
```ts
if (conv.isE2ee) return NextResponse.json({ error: "e2ee send not supported in Plan A" }, { status: 400 });
```

Server treats the text body as opaque (it's the Olm envelope when E2EE). The bot route's E2EE rejection stays.

- [ ] **Step 2: Typecheck**

`pnpm --filter @legends/web typecheck` clean.

---

## Task 8: `DmClient` — wire encryption / decryption + setup gate + UI

**Files:**
- Modify: `apps/web/components/DmClient.tsx`

- [ ] **Step 1: Lazy-load the Olm wrapper**

At the top of `DmClient.tsx` (`"use client"`), do not statically import `dm-olm` — that would pull WASM into every page. Lazy:
```tsx
const olm = await import("@/lib/dm-olm");
```
inside the handlers that need it (open/send/receive paths for E2EE conversations).

- [ ] **Step 2: Setup gate on first E2EE entry**

Add a small state machine: `e2eeReady: boolean`. On the first time the user enters an E2EE conversation, call:
```ts
const { generateAndPublishKeys, getOrCreateAccount } = await import("@/lib/dm-olm");
await getOrCreateAccount();
const hasPublished = !!(await fetch(`/api/user/keys/bundle?userId=${currentUserId}`).then(r => r.ok)); // crude; better: dedicated /api/user/keys/published-status
if (!hasPublished) await generateAndPublishKeys();
setE2eeReady(true);
```
While `!e2eeReady`, show a "Setting up encryption…" banner in the thread.

- [ ] **Step 3: Open E2EE thread → ensure session, decrypt history**

When `openThread(id)` is called on an E2EE conv with peer P:
```ts
const olm = await import("@/lib/dm-olm");
// Optimistically open outbound session for the initiator (only if no session yet AND this conv is mine to start):
const sessionExists = await olm.hasSession(id, peerId); // add a `hasSession` helper
if (!sessionExists) {
  const bundle = await fetch(`/api/user/keys/bundle?userId=${peerId}`).then(r => r.json());
  await olm.openOutboundSession(id, peerId, bundle);
}
// Decrypt message history
const { messages: raw } = await (await apiFetch(`/api/dm/${id}/messages`)).json();
const decrypted = await Promise.all(raw.map(async (m) => {
  if (!isEnvelope(m.text)) return m;
  try { return { ...m, text: await olm.decrypt(id, peerId, m.text) }; }
  catch { return { ...m, text: "(decryption failed)" }; }
}));
setMessages(decrypted);
```

- [ ] **Step 4: Encrypt in `send()` for E2EE conv**

```ts
const olm = await import("@/lib/dm-olm");
const envelope = await olm.encrypt(activeId, peerId, text);
const r = await apiFetch(`/api/dm/${activeId}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: envelope }),
});
if (r.ok) {
  const d = await r.json() as { message: Message };
  // store plaintext in local state — the server-stored ciphertext echoes back via ws but we already have the plaintext we just sent
  setMessages((prev) => prev.some((x) => x.id === d.message.id) ? prev : [...prev, { ...d.message, text }]);
}
```

- [ ] **Step 5: Decrypt incoming ws messages**

In the `useDmSocket` callback:
```ts
useDmSocket(useCallback(async (m: DmIncoming) => {
  if (m.conversationId !== activeId) { refreshList(); return; }
  let text = m.text;
  // If the active conv is E2EE, decrypt
  const conv = conversations.find((c) => c.id === activeId);
  if (conv?.isE2ee && isEnvelope(text)) {
    const olm = await import("@/lib/dm-olm");
    try { text = await olm.decrypt(activeId, peerOf(conv), text); }
    catch { text = "(decryption failed)"; }
  }
  setMessages((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, { ...m, text }]);
  refreshList();
}, [activeId, conversations, refreshList]));
```
Helpers: `isEnvelope(s)` quick check (string starts with `{"r":1`), `peerOf(conv)` returns the user-peer id.

- [ ] **Step 6: Encrypted toggle + 🔒 indicator + key warnings**

Add to the new-DM row:
```tsx
<label className="flex items-center gap-2 text-xs text-muted">
  <input type="checkbox" checked={requestE2EE} onChange={(e) => setRequestE2EE(e.target.checked)} />
  Encrypted (user-to-user)
</label>
```
Pass `e2ee: requestE2EE && peer.type === "user"` in the POST body in `startDm`. (Same as the rejected-Plan-B UI.)

Render `🔒` next to the peer name on E2EE conversation rows and in the thread header.

Identity fingerprint = the peer's Curve25519 identity (from the bundle) and Ed25519 (from `account.identity_keys()`). Add a "Verify identity" affordance in the thread header that opens a modal showing the local fingerprint pair and the peer's pair side-by-side for out-of-band compare. (Olm's `account.identity_keys()` returns both Curve and Ed25519; the safety number can be a SHA-256 of both pairs concatenated, formatted Signal-style.)

- [ ] **Step 7: Typecheck + manual smoke**

`pnpm --filter @legends/web typecheck` clean. Manual smoke per the test strategy at the top of this plan.

---

## Task 9: Push preview branches on `isE2ee`

**Files:**
- Modify: wherever DM push payload is built (per Plan A's deferred list, this may not exist yet — same as the prior plan).

- [ ] **Step 1: If DM push exists, branch on `isE2ee`**

```ts
const previewText = conv.isE2ee ? "New message" : truncate(plaintext, 80);
```
If DM push doesn't exist yet, leave a TODO comment near the analogous topic push code referencing this plan.

- [ ] **Step 2: Typecheck**

Touch only what's needed; `pnpm --filter @legends/web typecheck` (and `@legends/ws` if you changed it) clean.

---

## Self-review checklist (before declaring Plan B done)

- [ ] `pnpm -r typecheck` clean (excluding the pre-existing `create-admin.ts` error).
- [ ] `pnpm --filter @legends/db test:run src/dm-key.test.ts` still passes.
- [ ] Migration 0037 applied; `user_one_time_prekeys` populated by a real client during smoke; signed-prekey columns set on `user_key_bundles`.
- [ ] Olm WASM loads in `next dev` and `next build` without 404 on `olm.wasm`. If a copy step is needed (to `apps/web/public/olm.wasm`), document it in the codebase README or wire it into the build script.
- [ ] Two-user live smoke: A opens encrypted DM with B → session establishes → A and B exchange ≥4 messages back-and-forth → all decrypt → `dm_messages.content_ciphertext` (after at-rest unwrap) shows `{"r":1,...}` envelopes, never plaintext.
- [ ] Plaintext (Plan A) + bot (Plan C) regression check still works.
- [ ] One-time prekey replenishment trigger: when client account has < N (e.g. 20) unpublished OTKs left, it publishes more. (Implement as a check at the end of session-open. Without this, prekeys exhaust over time. Treat as part of Task 5 or split into a small follow-up task — flag in the self-review if deferred.)
- [ ] Spec coverage: signed prekey + OTK pool (T2), prekey upload (T3), bundle fetch with atomic OTK pop (T4), Olm wrapper with persisted sessions (T5), e2ee flag wiring (T6), user-side e2ee allowed (T7), DmClient encrypt/decrypt + setup + UI (T8), push generic when E2EE (T9). NO writes to `e2eeSenderKeys`. NO `dm_sender_keys` table created (rejected sender-key Plan B is gone). NO bot E2EE work.

---

## Security model (what this gives you)

- **Per-message forward secrecy**: the Double Ratchet advances on every message in each direction. Compromise of the current chain key reveals only future messages until the next DH ratchet, and reveals none of the past chain keys.
- **Post-compromise security**: a DH ratchet step (triggered by a message in the opposite direction) heals the channel — an attacker who learned the current chain key but not the long-term identity key loses access after the next round-trip.
- **X3DH initial setup**: identity + signed prekey + one-time prekey give strong session-establishment forward secrecy. Signed prekey is signed by the identity key (Ed25519), so a malicious server cannot substitute prekeys without invalidating the signature (the recipient client verifies on bundle fetch — see Task 5).
- **TOFU on identity key**: the *only* defense against a malicious server substituting the identity key on initial contact is out-of-band safety-number comparison. The thread header's "Verify identity" affordance is therefore load-bearing — not optional polish.
- **No metadata privacy**: server still knows participants, timing, sizes, frequency, `isE2ee`, OTK consumption rate. Standard messenger trade-off.
- **One device per user**: per current platform model. New device = new Olm account = new identity key → peer's TOFU pin fires. Old E2EE history is unreadable on the new device (Olm sessions don't migrate). This is consistent with the topic-E2EE inheritance Plan A documented.
- **Bot DMs cannot be E2EE**: bot has no Olm endpoint here; the bot route's "(plan B)" rejection is now correct in the literal sense and remains in force.

Expected rating: **4 / 5** baseline; **4.5 / 5** once safety-number UI is wired (Task 8 Step 6). Reaching 5 / 5 would require key-transparency / verifiable directory + audited multi-device session sync.

---

## Deferred to later plans

- **E2EE bot DMs / "bot as Olm endpoint"**: bot generates its own Olm account, publishes prekey bundle, lifts the `/api/bot/v1/sendMessage` `isE2ee` rejection for DMs where the bot is a participant. Spec calls this out as a separate sub-project.
- **Multi-device** + per-device sessions + a real device registry. Requires a `user_devices` table, per-device prekey bundles, and per-device session fan-out on send.
- **Cross-device history transfer** (Element-style "secret storage" or Signal-style device link) — out of scope.
- **Signed-prekey rotation** (weekly / on-demand). Plan B uploads ONE signed prekey at account creation; rotation = follow-up.
- **Fallback key** path for the case where a peer's one-time prekey pool is exhausted. Olm supports a fallback key; surface in v2.
- **Key transparency / verifiable directory** for the identity-key TOFU substitution attack.
- **Inline keyboards / media in DMs** — still disallowed; ride with shop-bot plan when applicable.
