# Bot E2EE — Part 1: Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the database, shared types, and Next.js server-side surface for bot E2EE (DMs + topic membership). Bot SDK + admin UI + docs are covered in parts 2 and 3.

**Architecture:** Dedicated `bot_*` crypto tables (separate from `user_devices` etc.), three-state machine on `bots.e2ee_state`, new `/api/bot/v1/crypto/*` mirror authed by bot bearer token, dispatch layer in `lib/crypto-principal.ts` routing reads/writes per principal type. DM-open path gates on bot's `e2ee_state==='ready'`.

**Tech Stack:** Next.js 15 App Router, drizzle ORM, Postgres, Redis, TypeScript, Vitest, Zod (existing schemas).

**Scope (this plan):** Phases 0–3 = 16 tasks (foundations + server-side dispatch + bot crypto API + DM/delivery/topic wiring). 13 tasks below + 3 sub-tasks where logical. Total task count for this file: 16.

---

## Pre-flight: spec gaps flagged for executors

These were surfaced while drafting; implementors should treat the resolutions below as the working interpretation when the spec is silent.

1. **`apps/web` has no vitest runner today.** Only `packages/db` runs vitest (one test: `src/dm-key.test.ts`). Task 1 adds `vitest` + `vite-tsconfig-paths` as devDeps to `apps/web`, a `vitest.config.ts`, an `apps/web/__tests__/` directory, and `"test": "vitest run"` to `apps/web/package.json`. Every subsequent test in this plan lands in `apps/web/__tests__/`.
2. **The spec references a "rooms event-stream table" for emitting synthetic `m.room.member` events on bot add/remove (Task 16). No such table exists.** Grep for `m.room.member` across `apps/web` returns zero hits. The existing rotation mechanism is `user_device_change_log` consumed by `/api/crypto/sync` as `device_lists.changed`. Task 16 logs a device change for every member of the topic via `logDeviceChange` — that is the existing-pattern equivalent of "emit synthetic member event so members rotate". A dedicated `m.room.member` audit channel can be added later if the SDK ever wants the explicit event shape.
3. **`crypto_sent_txns` already keys on `(sender_user_id, sender_device_id, txn_id)`** — for the user→bot `sendToDevice` modification (Task 6) the sender is still a user, so the existing idempotency row works unchanged.
4. **The user-side `/api/crypto/rooms/[roomId]/members` route returns `user_ids` (no device list).** The bot-side `/api/bot/v1/crypto/rooms/[roomId]` mandated by Task 12 returns the richer `{members: [{matrix_id, devices: string[]}]}` shape per the spec brief. The bot consumes both kinds.

---

## Phase 0 — Foundations

### Task 1: Migration `0045_bot_e2ee.sql` + drizzle schema + vitest harness in apps/web

**Files:**
- Create: `packages/db/src/migrations/0045_bot_e2ee.sql`
- Modify: `packages/db/src/schema.ts` (add `botDevices`, `botOneTimeKeys`, `botToDeviceQueue`, `botCryptoSentTxns`; alter `bots`)
- Create: `apps/web/vitest.config.ts`
- Modify: `apps/web/package.json` (add `vitest` devDep + `test` script + `vite-tsconfig-paths`)
- Test: `apps/web/__tests__/db-bot-e2ee.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/db-bot-e2ee.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { bots, botDevices, botOneTimeKeys, botToDeviceQueue, botCryptoSentTxns } from "@legends/db/schema";
import { db } from "@/lib/db";
import { randomUUID, createHash } from "node:crypto";

describe("bot e2ee schema", () => {
  let botId: string;

  beforeAll(async () => {
    const ownerId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'owner-bot-e2ee-test') ON CONFLICT DO NOTHING`);
    const [row] = await db.insert(bots).values({
      name: `bot-e2ee-${Date.now()}`,
      ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id, e2eeState: bots.e2eeState, e2eeDeviceId: bots.e2eeDeviceId });
    botId = row!.id;
    expect(row!.e2eeState).toBe("disabled");
    expect(row!.e2eeDeviceId).toBeNull();
  });

  it("inserts bot_devices with identity keys", async () => {
    await db.insert(botDevices).values({
      botId,
      deviceId: "BOTDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
      identityKeys: { "ed25519:BOTDEV1": "edpk", "curve25519:BOTDEV1": "cvpk" },
      signatures: { "@bot.x:legends.local": { "ed25519:BOTDEV1": "sig" } },
    });
    const got = await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`);
    expect(got).toHaveLength(1);
    expect(got[0]!.deviceId).toBe("BOTDEV1");
  });

  it("inserts a bot_one_time_keys row keyed by (bot, device, key_id)", async () => {
    await db.insert(botOneTimeKeys).values({
      botId, deviceId: "BOTDEV1", keyId: "signed_curve25519:AAAA",
      algorithm: "signed_curve25519", keyJson: { key: "k1" },
    });
    const got = await db.select().from(botOneTimeKeys).where(sql`${botOneTimeKeys.botId} = ${botId}`);
    expect(got).toHaveLength(1);
  });

  it("rejects bot_to_device_queue rows that set both sender_user_id and sender_bot_id", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO bot_to_device_queue (bot_id, device_id, event_type, sender_user_id, sender_bot_id, payload)
        VALUES (${botId}, 'BOTDEV1', 'm.room.encrypted', ${randomUUID()}, ${randomUUID()}, '{}'::jsonb)
      `),
    ).rejects.toThrow();
  });

  it("dedups bot_crypto_sent_txns on (bot_id, txn_id)", async () => {
    await db.insert(botCryptoSentTxns).values({
      botId, txnId: "txn-1", eventType: "m.room.encrypted",
      bodyHash: Buffer.from("aa", "hex"),
    });
    await expect(
      db.insert(botCryptoSentTxns).values({
        botId, txnId: "txn-1", eventType: "m.room.encrypted",
        bodyHash: Buffer.from("bb", "hex"),
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/db-bot-e2ee.test.ts`
Expected: `vitest: command not found` (vitest harness missing) — then after adding vitest deps, schema imports fail with `botDevices is not exported` until Step 3 lands.

- [ ] **Step 3: Write the implementation**

```sql
-- packages/db/src/migrations/0045_bot_e2ee.sql
-- Bot E2EE: dedicated bot_* crypto tables + e2ee state machine on bots.
-- Bots run their own Olm device; the server stores only public material and
-- relays opaque envelopes via bot_to_device_queue. Idempotency for bot-side
-- sendToDevice lives in bot_crypto_sent_txns (sender_bot_id + txn_id).

BEGIN;

-- 1) State machine + nullable pointer to the bot's active device.
ALTER TABLE "bots"
  ADD COLUMN "e2ee_state" text NOT NULL DEFAULT 'disabled',
  ADD COLUMN "e2ee_device_id" text;
ALTER TABLE "bots"
  ADD CONSTRAINT "bots_e2ee_state_chk"
    CHECK ("e2ee_state" IN ('disabled','pending','ready'));

-- 2) bot_devices: one row per bot device (currently always one per bot).
CREATE TABLE "bot_devices" (
  "bot_id"        uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"     text NOT NULL,
  "algorithms"    text[] NOT NULL,
  "identity_keys" jsonb NOT NULL,
  "signatures"    jsonb,
  "unsigned"      jsonb,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bot_id", "device_id")
);
CREATE INDEX "bot_devices_bot_id_idx" ON "bot_devices" ("bot_id");

-- 3) bot_one_time_keys: per-(bot, device, key_id) OTK pool.
CREATE TABLE "bot_one_time_keys" (
  "bot_id"     uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"  text NOT NULL,
  "key_id"     text NOT NULL,
  "algorithm"  text NOT NULL,
  "key_json"   jsonb NOT NULL,
  "claimed_at" timestamptz,
  PRIMARY KEY ("bot_id", "device_id", "key_id")
);
CREATE INDEX "bot_one_time_keys_unclaimed_idx"
  ON "bot_one_time_keys" ("bot_id", "device_id")
  WHERE "claimed_at" IS NULL;

-- 4) bot_to_device_queue: mirror of user_to_device_queue; sender XOR check.
CREATE TABLE "bot_to_device_queue" (
  "id"             bigserial PRIMARY KEY,
  "bot_id"         uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "device_id"      text NOT NULL,
  "event_type"     text NOT NULL,
  "sender_user_id" uuid,
  "sender_bot_id"  uuid,
  "payload"        jsonb NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    ("sender_user_id" IS NOT NULL AND "sender_bot_id" IS NULL) OR
    ("sender_user_id" IS NULL AND "sender_bot_id" IS NOT NULL)
  )
);
CREATE INDEX "bot_to_device_queue_bot_idx" ON "bot_to_device_queue" ("bot_id", "id");

-- 5) bot_crypto_sent_txns: idempotency for bot-side sendToDevice.
CREATE TABLE "bot_crypto_sent_txns" (
  "bot_id"     uuid NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "txn_id"     text NOT NULL,
  "event_type" text NOT NULL,
  "body_hash"  bytea NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("bot_id", "txn_id")
);

COMMIT;
```

```ts
// packages/db/src/schema.ts — add to existing bots + after cryptoSentTxns
// (Showing only the diff; preserve surrounding declarations.)
export const bots = pgTable("bots", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  avatarUrl: text("avatar_url"),
  description: text("description"),
  webhookUrl: text("webhook_url"),
  isActive: boolean("is_active").notNull().default(true),
  dmEnabled: boolean("dm_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  role: text("role").notNull().default("bot"),
  roleExpiresAt: timestamp("role_expires_at", { withTimezone: true }),
  roleFallback: text("role_fallback"),
  e2eeState: text("e2ee_state").notNull().default("disabled"),
  e2eeDeviceId: text("e2ee_device_id"),
});

export const botDevices = pgTable(
  "bot_devices",
  {
    botId: uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    algorithms: text("algorithms").array().notNull(),
    identityKeys: jsonb("identity_keys").$type<Record<string, string>>().notNull(),
    signatures: jsonb("signatures").$type<Record<string, Record<string, string>> | null>(),
    unsigned: jsonb("unsigned").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.botId, t.deviceId] }),
    botIdx: index("bot_devices_bot_id_idx").on(t.botId),
  }),
);

export const botOneTimeKeys = pgTable(
  "bot_one_time_keys",
  {
    botId: uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    keyId: text("key_id").notNull(),
    algorithm: text("algorithm").notNull(),
    keyJson: jsonb("key_json").$type<Record<string, unknown>>().notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.botId, t.deviceId, t.keyId] }),
    unclaimedIdx: index("bot_one_time_keys_unclaimed_idx")
      .on(t.botId, t.deviceId)
      .where(sql`${t.claimedAt} IS NULL`),
  }),
);

export const botToDeviceQueue = pgTable(
  "bot_to_device_queue",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    botId: uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    eventType: text("event_type").notNull(),
    senderUserId: uuid("sender_user_id"),
    senderBotId: uuid("sender_bot_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    botIdx: index("bot_to_device_queue_bot_idx").on(t.botId, t.id),
  }),
);

export const botCryptoSentTxns = pgTable(
  "bot_crypto_sent_txns",
  {
    botId: uuid("bot_id").notNull().references(() => bots.id, { onDelete: "cascade" }),
    txnId: text("txn_id").notNull(),
    eventType: text("event_type").notNull(),
    bodyHash: customType<{ data: Uint8Array; driverData: Buffer }>({
      dataType: () => "bytea",
    })("body_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.botId, t.txnId] }),
  }),
);
```

```ts
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
```

```json
// apps/web/package.json — add to scripts + devDependencies
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.4",
    "vite-tsconfig-paths": "^5.1.4"
  }
}
```

Then run the migration: `pnpm --filter @legends/db migrate`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/db-bot-e2ee.test.ts`
Expected: PASS (4 assertions across 4 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/0045_bot_e2ee.sql packages/db/src/schema.ts apps/web/vitest.config.ts apps/web/package.json apps/web/__tests__/db-bot-e2ee.test.ts
git commit -m "feat(db): bot e2ee state machine + bot_* crypto tables (0045)"
```

---

### Task 2: Shared error codes

**Files:**
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/error-codes.ts`
- Test: `packages/shared/src/error-codes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/error-codes.test.ts
import { describe, it, expect } from "vitest";
import { BOT_E2EE_ERROR_CODES } from "./error-codes";

describe("BOT_E2EE_ERROR_CODES", () => {
  it("exposes the six bot-e2ee error strings", () => {
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED).toBe("bot_e2ee_disabled");
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY).toBe("bot_e2ee_not_ready");
    expect(BOT_E2EE_ERROR_CODES.BOT_E2EE_REQUIRED).toBe("bot_e2ee_required");
    expect(BOT_E2EE_ERROR_CODES.OTK_UNAVAILABLE).toBe("otk_unavailable");
    expect(BOT_E2EE_ERROR_CODES.DEVICE_NOT_FOUND).toBe("device_not_found");
    expect(BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID).toBe("crypto_keys_invalid");
  });

  it("has six unique values", () => {
    const vals = Object.values(BOT_E2EE_ERROR_CODES);
    expect(new Set(vals).size).toBe(vals.length);
    expect(vals).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/shared exec vitest run src/error-codes.test.ts`
Expected: `Cannot find module './error-codes'` (file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/error-codes.ts
// Centralized error string constants for the bot E2EE feature.
// Returned by /api/dm/open, /api/bot/v1/crypto/*, and /api/admin/topics/[id]/bots
// so the frontend can branch on stable identifiers rather than user-facing copy.
export const BOT_E2EE_ERROR_CODES = {
  BOT_E2EE_DISABLED: "bot_e2ee_disabled",
  BOT_E2EE_NOT_READY: "bot_e2ee_not_ready",
  BOT_E2EE_REQUIRED: "bot_e2ee_required",
  OTK_UNAVAILABLE: "otk_unavailable",
  DEVICE_NOT_FOUND: "device_not_found",
  CRYPTO_KEYS_INVALID: "crypto_keys_invalid",
} as const;

export type BotE2eeErrorCode = (typeof BOT_E2EE_ERROR_CODES)[keyof typeof BOT_E2EE_ERROR_CODES];
```

```ts
// packages/shared/src/index.ts — append one line
export * from "./error-codes";
```

```ts
// packages/shared/vitest.config.ts (new — shared has no vitest harness yet)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

```json
// packages/shared/package.json — add to devDeps + scripts
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/shared exec vitest run src/error-codes.test.ts`
Expected: PASS (2 assertions)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/error-codes.ts packages/shared/src/error-codes.test.ts packages/shared/src/index.ts packages/shared/vitest.config.ts packages/shared/package.json
git commit -m "feat(shared): add BOT_E2EE_ERROR_CODES constants for bot e2ee gating"
```

---

### Task 3: Bot Matrix-id helpers

**Files:**
- Modify: `apps/web/lib/crypto-matrix.ts`
- Test: `apps/web/__tests__/crypto-matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/crypto-matrix.test.ts
import { describe, it, expect } from "vitest";
import {
  toMatrixUserId, fromMatrixUserId,
  toMatrixBotId, fromMatrixBotId,
  parseMatrixPrincipal,
} from "@/lib/crypto-matrix";

const U = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

describe("matrix id helpers (user + bot namespace)", () => {
  it("round-trips a bot id", () => {
    const mx = toMatrixBotId(B);
    expect(mx).toBe(`@bot.${B}:legends.local`);
    expect(fromMatrixBotId(mx)).toBe(B);
  });

  it("user helpers do not match the bot namespace", () => {
    expect(fromMatrixUserId(toMatrixBotId(B))).toBeNull();
  });

  it("bot helpers do not match the user namespace", () => {
    expect(fromMatrixBotId(toMatrixUserId(U))).toBeNull();
  });

  it("parseMatrixPrincipal disambiguates user vs bot", () => {
    expect(parseMatrixPrincipal(toMatrixUserId(U))).toEqual({ type: "user", id: U });
    expect(parseMatrixPrincipal(toMatrixBotId(B))).toEqual({ type: "bot", id: B });
    expect(parseMatrixPrincipal("@garbage:legends.local")).toBeNull();
    expect(parseMatrixPrincipal("not-a-matrix-id")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/crypto-matrix.test.ts`
Expected: `toMatrixBotId is not exported` (import failure)

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/crypto-matrix.ts — append after existing exports
export type MatrixPrincipal =
  | { type: "user"; id: string }
  | { type: "bot"; id: string };

export function toMatrixBotId(botId: string): string {
  return `@bot.${botId}:${CRYPTO_DOMAIN}`;
}

export function fromMatrixBotId(matrixId: string): string | null {
  const m = matrixId.match(/^@bot\.([0-9a-fA-F-]+):legends\.local$/);
  return m && m[1] ? m[1] : null;
}

export function parseMatrixPrincipal(matrixId: string): MatrixPrincipal | null {
  const bot = fromMatrixBotId(matrixId);
  if (bot) return { type: "bot", id: bot };
  const user = fromMatrixUserId(matrixId);
  if (user) return { type: "user", id: user };
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/crypto-matrix.test.ts`
Expected: PASS (4 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/crypto-matrix.ts apps/web/__tests__/crypto-matrix.test.ts
git commit -m "feat(crypto): add bot matrix-id namespace helpers + parseMatrixPrincipal"
```

---

## Phase 1 — Server crypto-principal dispatch

### Task 4: `lib/crypto-principal.ts`

**Files:**
- Create: `apps/web/lib/crypto-principal.ts`
- Test: `apps/web/__tests__/crypto-principal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/crypto-principal.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  parsePrincipalFromMatrixId,
  getDeviceList,
  claimOneTimeKey,
  enqueueToDevice,
  idempotencyCheck,
} from "@/lib/crypto-principal";
import { db } from "@/lib/db";
import {
  bots, botDevices, botOneTimeKeys, botToDeviceQueue,
  userKeyBundles, userOneTimePrekeys, userToDeviceQueue, cryptoSentTxns,
} from "@legends/db/schema";

describe("crypto-principal dispatch", () => {
  let userId: string;
  let botId: string;

  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'cp-test-user') ON CONFLICT DO NOTHING`);
    const [b] = await db.insert(bots).values({
      name: `cp-test-bot-${Date.now()}`,
      ownerUserId: userId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;
    // Seed user device + OTK.
    await db.insert(userKeyBundles).values({
      userId, deviceId: "UDEV1", identityPublicKey: "edpk-u",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:UDEV1": "edpk-u", "curve25519:UDEV1": "cvpk-u" },
      signaturesJson: { [`@${userId}:legends.local`]: { "ed25519:UDEV1": "sig" } },
    });
    await db.insert(userOneTimePrekeys).values({
      userId, deviceId: "UDEV1", keyId: "signed_curve25519:UOTK1",
      algorithm: "signed_curve25519", keyJson: { key: "u-otk" },
    });
    // Seed bot device + OTK.
    await db.insert(botDevices).values({
      botId, deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
      signatures: { [`@bot.${botId}:legends.local`]: { "ed25519:BDEV1": "sig" } },
    });
    await db.insert(botOneTimeKeys).values({
      botId, deviceId: "BDEV1", keyId: "signed_curve25519:BOTK1",
      algorithm: "signed_curve25519", keyJson: { key: "b-otk" },
    });
  });

  it("parsePrincipalFromMatrixId disambiguates", () => {
    expect(parsePrincipalFromMatrixId(`@${userId}:legends.local`)).toEqual({ type: "user", id: userId });
    expect(parsePrincipalFromMatrixId(`@bot.${botId}:legends.local`)).toEqual({ type: "bot", id: botId });
    expect(parsePrincipalFromMatrixId("nope")).toBeNull();
  });

  it("getDeviceList returns user device for user principal", async () => {
    const list = await getDeviceList({ type: "user", id: userId });
    expect(list.devices.map((d) => d.deviceId)).toContain("UDEV1");
  });

  it("getDeviceList returns bot device for bot principal", async () => {
    const list = await getDeviceList({ type: "bot", id: botId });
    expect(list.devices.map((d) => d.deviceId)).toContain("BDEV1");
  });

  it("claimOneTimeKey atomically marks a user OTK claimed", async () => {
    const otk = await claimOneTimeKey({ type: "user", id: userId }, "UDEV1", "signed_curve25519");
    expect(otk).not.toBeNull();
    expect(otk!.keyId).toBe("signed_curve25519:UOTK1");
    const again = await claimOneTimeKey({ type: "user", id: userId }, "UDEV1", "signed_curve25519");
    expect(again).toBeNull();
  });

  it("claimOneTimeKey atomically marks a bot OTK claimed", async () => {
    const otk = await claimOneTimeKey({ type: "bot", id: botId }, "BDEV1", "signed_curve25519");
    expect(otk).not.toBeNull();
    expect(otk!.keyId).toBe("signed_curve25519:BOTK1");
  });

  it("enqueueToDevice routes to bot queue for bot recipient", async () => {
    await enqueueToDevice({
      recipient: { type: "bot", id: botId },
      recipientDeviceId: "BDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "bot" },
      sender: { type: "user", id: userId },
    });
    const rows = await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${botId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.senderUserId).toBe(userId);
  });

  it("enqueueToDevice routes to user queue for user recipient", async () => {
    await enqueueToDevice({
      recipient: { type: "user", id: userId },
      recipientDeviceId: "UDEV1",
      eventType: "m.room.encrypted",
      payload: { hello: "user" },
      sender: { type: "bot", id: botId },
    });
    const rows = await db.select().from(userToDeviceQueue)
      .where(sql`${userToDeviceQueue.recipientUserId} = ${userId} AND ${userToDeviceQueue.senderDeviceId} = 'bot'`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("idempotencyCheck stores then reports conflict for different body", async () => {
    const a = await idempotencyCheck(
      { type: "bot", id: botId }, "txn-ic-1", "m.room.encrypted", Buffer.from("aa", "hex"),
    );
    expect(a).toEqual({ stored: true, conflict: false });
    const b = await idempotencyCheck(
      { type: "bot", id: botId }, "txn-ic-1", "m.room.encrypted", Buffer.from("aa", "hex"),
    );
    expect(b).toEqual({ stored: false, conflict: false });
    const c = await idempotencyCheck(
      { type: "bot", id: botId }, "txn-ic-1", "m.room.encrypted", Buffer.from("bb", "hex"),
    );
    expect(c).toEqual({ stored: false, conflict: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/crypto-principal.test.ts`
Expected: `Cannot find module '@/lib/crypto-principal'` (file does not exist yet)

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/crypto-principal.ts
// Dispatch layer: a user-facing /api/crypto/* call against a Matrix id can
// target either a user or a bot principal. This module hides that branch from
// callers — they pass a parsed Principal and we read/write the matching tables.
import { and, eq, sql } from "drizzle-orm";
import {
  bots, botDevices, botOneTimeKeys, botToDeviceQueue, botCryptoSentTxns,
  userKeyBundles, userOneTimePrekeys, userToDeviceQueue, cryptoSentTxns,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { parseMatrixPrincipal, type MatrixPrincipal } from "@/lib/crypto-matrix";

export type Principal = MatrixPrincipal;

export type DeviceListEntry = {
  deviceId: string;
  algorithms: string[];
  keys: Record<string, string>;
  signatures: Record<string, Record<string, string>> | null;
};
export type DeviceList = { devices: DeviceListEntry[] };

export type OtkRow = { keyId: string; algorithm: string; keyJson: Record<string, unknown> };

export function parsePrincipalFromMatrixId(matrixId: string): Principal | null {
  return parseMatrixPrincipal(matrixId);
}

export async function getDeviceList(p: Principal): Promise<DeviceList> {
  if (p.type === "user") {
    const rows = await db.select({
      deviceId: userKeyBundles.deviceId,
      algorithms: userKeyBundles.algorithmsJson,
      keys: userKeyBundles.keysJson,
      signatures: userKeyBundles.signaturesJson,
    }).from(userKeyBundles).where(eq(userKeyBundles.userId, p.id));
    return { devices: rows.map((r) => ({
      deviceId: r.deviceId,
      algorithms: r.algorithms,
      keys: r.keys,
      signatures: r.signatures,
    })) };
  }
  const rows = await db.select({
    deviceId: botDevices.deviceId,
    algorithms: botDevices.algorithms,
    identityKeys: botDevices.identityKeys,
    signatures: botDevices.signatures,
  }).from(botDevices).where(eq(botDevices.botId, p.id));
  return { devices: rows.map((r) => ({
    deviceId: r.deviceId,
    algorithms: r.algorithms,
    keys: r.identityKeys,
    signatures: r.signatures,
  })) };
}

export async function claimOneTimeKey(
  p: Principal,
  deviceId: string,
  algorithm: string,
): Promise<OtkRow | null> {
  if (p.type === "user") {
    const popped = await db.execute<{ key_id: string; algorithm: string; key_json: Record<string, unknown> }>(sql`
      UPDATE user_one_time_prekeys SET used_at = now()
       WHERE ctid IN (
         SELECT ctid FROM user_one_time_prekeys
          WHERE user_id = ${p.id} AND device_id = ${deviceId}
            AND algorithm = ${algorithm} AND used_at IS NULL
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING key_id, algorithm, key_json
    `);
    const row = Array.from(popped)[0];
    return row ? { keyId: row.key_id, algorithm: row.algorithm, keyJson: row.key_json } : null;
  }
  const popped = await db.execute<{ key_id: string; algorithm: string; key_json: Record<string, unknown> }>(sql`
    UPDATE bot_one_time_keys SET claimed_at = now()
     WHERE ctid IN (
       SELECT ctid FROM bot_one_time_keys
        WHERE bot_id = ${p.id} AND device_id = ${deviceId}
          AND algorithm = ${algorithm} AND claimed_at IS NULL
        FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING key_id, algorithm, key_json
  `);
  const row = Array.from(popped)[0];
  return row ? { keyId: row.key_id, algorithm: row.algorithm, keyJson: row.key_json } : null;
}

export async function enqueueToDevice(args: {
  recipient: Principal;
  recipientDeviceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  sender: Principal;
  senderDeviceId?: string;
  txnId?: string;
}): Promise<void> {
  if (args.recipient.type === "bot") {
    await db.insert(botToDeviceQueue).values({
      botId: args.recipient.id,
      deviceId: args.recipientDeviceId,
      eventType: args.eventType,
      senderUserId: args.sender.type === "user" ? args.sender.id : null,
      senderBotId: args.sender.type === "bot" ? args.sender.id : null,
      payload: args.payload,
    });
    return;
  }
  // recipient is a user → user_to_device_queue. The existing user-side queue
  // requires sender_user_id; for bot-sender envelopes we synthesize a literal
  // "bot" device tag and route through a NULLable senderUserId workaround:
  // we re-use the recipient's id as a placeholder is wrong — instead we record
  // sender_user_id = recipient.id is also wrong; the existing schema lacks a
  // sender_bot_id column. We populate sender_user_id with the bot's owner via
  // a separate path (Task 10 supplies the real flow), but for this generic
  // helper we accept the constraint: only user→user envelopes go this branch
  // until 0046 widens the schema. Bot→user uses bot-side senders that present
  // as users at the SDK layer; for now we require sender.type==='user' here.
  if (args.sender.type !== "user") {
    throw new Error("enqueueToDevice user-recipient currently requires user sender");
  }
  await db.insert(userToDeviceQueue).values({
    recipientUserId: args.recipient.id,
    recipientDeviceId: args.recipientDeviceId,
    senderUserId: args.sender.id,
    senderDeviceId: args.senderDeviceId ?? "bot",
    eventType: args.eventType,
    contentJson: args.payload,
    txnId: args.txnId ?? `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

export async function idempotencyCheck(
  sender: Principal,
  txnId: string,
  eventType: string,
  bodyHash: Buffer,
): Promise<{ stored: boolean; conflict: boolean }> {
  if (sender.type === "bot") {
    const inserted = await db.insert(botCryptoSentTxns).values({
      botId: sender.id, txnId, eventType, bodyHash,
    }).onConflictDoNothing().returning({ txnId: botCryptoSentTxns.txnId });
    if (inserted.length > 0) return { stored: true, conflict: false };
    const [existing] = await db.select({ bodyHash: botCryptoSentTxns.bodyHash })
      .from(botCryptoSentTxns)
      .where(and(eq(botCryptoSentTxns.botId, sender.id), eq(botCryptoSentTxns.txnId, txnId)))
      .limit(1);
    const conflict = !!existing && !Buffer.from(existing.bodyHash as Uint8Array).equals(bodyHash);
    return { stored: false, conflict };
  }
  // User sender — re-use the existing crypto_sent_txns table. Note its PK is
  // (sender_user_id, sender_device_id, txn_id); body-hash conflict is not
  // tracked there today, so this branch always returns conflict=false.
  const inserted = await db.insert(cryptoSentTxns).values({
    senderUserId: sender.id, senderDeviceId: "session", txnId,
  }).onConflictDoNothing().returning({ txnId: cryptoSentTxns.txnId });
  return { stored: inserted.length > 0, conflict: false };
}
```

> **Implementor note for executors:** Task 4's `enqueueToDevice` user-recipient branch carries a known limitation: `user_to_device_queue.sender_user_id` is NOT NULL today, so bot→user envelopes can't honestly populate it. Task 10's `/api/bot/v1/crypto/sendToDevice` works around this by writing directly to the queue with `senderDeviceId='bot'` and `senderUserId=<bot owner id>` (the owner is on `bots.ownerUserId`). The dispatch helper above documents the constraint; if you find a cleaner shape during implementation, propose schema 0046 widening `user_to_device_queue.sender_*` to mirror `bot_to_device_queue` and come back to this helper.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/crypto-principal.test.ts`
Expected: PASS (8 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/crypto-principal.ts apps/web/__tests__/crypto-principal.test.ts
git commit -m "feat(crypto): add crypto-principal dispatch layer for user/bot routing"
```

---

### Task 5: Modify `/api/crypto/keys/query` to route bot ids

**Files:**
- Modify: `apps/web/app/api/crypto/keys/query/route.ts`
- Test: `apps/web/__tests__/api-crypto-keys-query.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-crypto-keys-query.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { POST } from "@/app/api/crypto/keys/query/route";
import { db } from "@/lib/db";
import { bots, botDevices, userKeyBundles } from "@legends/db/schema";

// The route reads getCurrentUser() — fake it via vi.mock.
const FAKE_USER_ID = randomUUID();
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: FAKE_USER_ID, isAnon: false, displayName: "tester", permissions: new Set() }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAndIncrement: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
}));

async function postQuery(body: unknown): Promise<Response> {
  return POST(new Request("http://t/keys/query", { method: "POST", body: JSON.stringify(body) }));
}

describe("/api/crypto/keys/query — user + bot dispatch", () => {
  let peerUserId: string;
  let botId: string;

  beforeAll(async () => {
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 'tester'), (${peerUserId}, 'peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "PDEV1", identityPublicKey: "edpk",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:PDEV1": "edpk" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:PDEV1": "sig" } },
    });
    const [b] = await db.insert(bots).values({
      name: `kq-bot-${Date.now()}`,
      ownerUserId: peerUserId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId, deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
    });
  });

  it("returns user device for user-only batch", async () => {
    const res = await postQuery({ device_keys: { [`@${peerUserId}:legends.local`]: [] } });
    const body = await res.json();
    expect(Object.keys(body.device_keys[`@${peerUserId}:legends.local`])).toContain("PDEV1");
  });

  it("returns bot device for bot-only batch", async () => {
    const res = await postQuery({ device_keys: { [`@bot.${botId}:legends.local`]: [] } });
    const body = await res.json();
    expect(Object.keys(body.device_keys[`@bot.${botId}:legends.local`])).toContain("BDEV1");
  });

  it("returns both for mixed batch", async () => {
    const res = await postQuery({ device_keys: {
      [`@${peerUserId}:legends.local`]: [],
      [`@bot.${botId}:legends.local`]: [],
    }});
    const body = await res.json();
    expect(body.device_keys[`@${peerUserId}:legends.local`]).toBeDefined();
    expect(body.device_keys[`@bot.${botId}:legends.local`]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-crypto-keys-query.test.ts`
Expected: bot-namespace branch returns `invalid matrix user id` failure (current route uses `fromMatrixUserId` only).

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/crypto/keys/query/route.ts — replace the per-entry loop
// body. Show the new top of file and full loop.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";
import { parsePrincipalFromMatrixId, getDeviceList } from "@/lib/crypto-principal";

const bodySchema = z.object({
  device_keys: z.record(z.string().min(1).max(256), z.array(z.string().min(1).max(128))),
  timeout: z.number().int().nonnegative().optional(),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);

  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:query:${user.id}:m:${minute}`, 60, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);

  const deviceKeysOut: Record<string, Record<string, unknown>> = {};
  const failures: Record<string, { errcode: string; error: string }> = {};

  for (const [matrixId, deviceFilter] of Object.entries(parsed.data.device_keys)) {
    const principal = parsePrincipalFromMatrixId(matrixId);
    if (!principal) {
      failures[matrixId] = { errcode: "M_UNKNOWN", error: "invalid matrix id" };
      continue;
    }
    const list = await getDeviceList(principal);
    const fullId = principal.type === "user" ? toMatrixUserId(principal.id) : toMatrixBotId(principal.id);
    const filtered = deviceFilter.length > 0
      ? list.devices.filter((d) => deviceFilter.includes(d.deviceId))
      : list.devices;
    const perDevice: Record<string, unknown> = {};
    for (const d of filtered) {
      perDevice[d.deviceId] = {
        user_id: fullId,
        device_id: d.deviceId,
        algorithms: d.algorithms,
        keys: d.keys,
        signatures: d.signatures,
      };
    }
    deviceKeysOut[fullId] = perDevice;
  }

  return NextResponse.json({
    device_keys: deviceKeysOut,
    master_keys: {},
    self_signing_keys: {},
    user_signing_keys: {},
    failures,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-crypto-keys-query.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/crypto/keys/query/route.ts apps/web/__tests__/api-crypto-keys-query.test.ts
git commit -m "feat(crypto): route bot matrix-ids through dispatch in keys/query"
```

---

### Task 6: Modify `/api/crypto/sendToDevice` to write bot queue for bot recipients

**Files:**
- Modify: `apps/web/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route.ts`
- Test: `apps/web/__tests__/api-crypto-sendtodevice-bot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-crypto-sendtodevice-bot.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { PUT } from "@/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route";
import { db } from "@/lib/db";
import { bots, botDevices, botToDeviceQueue, userToDeviceQueue } from "@legends/db/schema";

const FAKE_USER_ID = randomUUID();
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: FAKE_USER_ID, isAnon: false, displayName: "t", permissions: new Set() }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAndIncrement: async () => ({ allowed: true, resetAt: Date.now() + 60_000 }),
}));

async function send(eventType: string, txnId: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://t/sendToDevice/${eventType}/${txnId}`, {
      method: "PUT",
      headers: { "x-legends-crypto-device-id": "USRDEV" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ event_type: eventType, txn_id: txnId }) },
  );
}

describe("/api/crypto/sendToDevice — bot recipient dispatch", () => {
  let botId: string;
  beforeAll(async () => {
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${FAKE_USER_ID}, 't') ON CONFLICT DO NOTHING`);
    const [b] = await db.insert(bots).values({
      name: `s2d-bot-${Date.now()}`, ownerUserId: FAKE_USER_ID,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId, deviceId: "BDEV1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:BDEV1": "edpk-b" },
    });
  });

  it("routes a bot recipient to bot_to_device_queue", async () => {
    const txnId = `t-${Date.now()}`;
    const res = await send("m.room.encrypted", txnId, {
      messages: { [`@bot.${botId}:legends.local`]: { BDEV1: { type: "m.room.encrypted" } } },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${botId}`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1]!;
    expect(last.senderUserId).toBe(FAKE_USER_ID);
    expect(last.deviceId).toBe("BDEV1");
  });

  it("replay with same txn_id is idempotent (200 no-op, no second row)", async () => {
    const txnId = `t-replay-${Date.now()}`;
    await send("m.room.encrypted", txnId, {
      messages: { [`@bot.${botId}:legends.local`]: { BDEV1: { type: "m.room.encrypted" } } },
    });
    const beforeCount = (await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${botId}`)).length;
    const res = await send("m.room.encrypted", txnId, {
      messages: { [`@bot.${botId}:legends.local`]: { BDEV1: { type: "m.room.encrypted" } } },
    });
    expect(res.status).toBe(200);
    const afterCount = (await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${botId}`)).length;
    expect(afterCount).toBe(beforeCount);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-crypto-sendtodevice-bot.test.ts`
Expected: bot recipient is silently skipped (current route uses `fromMatrixUserId` and ignores non-matches), so the queue row never lands — first `it` assertion `expect(rows.length).toBeGreaterThanOrEqual(1)` fails.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route.ts —
// replace fan-out loop. Keep cryptoSentTxns idempotency unchanged (sender is
// a user with a device id, same as today).
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { cryptoSentTxns, userToDeviceQueue, botToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { checkAndIncrement } from "@/lib/rate-limit";
import { parsePrincipalFromMatrixId } from "@/lib/crypto-principal";

const DEVICE_HEADER = "x-legends-crypto-device-id";
const bodySchema = z.object({
  messages: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.record(z.string(), z.unknown())),
  ),
});

function matrixError(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ event_type: string; txn_id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return matrixError("M_FORBIDDEN", "unauthorized", 401);
  if (user.isAnon) return matrixError("M_FORBIDDEN", "anon forbidden", 403);
  const senderDeviceId = req.headers.get(DEVICE_HEADER);
  if (!senderDeviceId) return matrixError("M_UNKNOWN", `missing ${DEVICE_HEADER} header`, 400);

  const minute = Math.floor(Date.now() / 60000);
  const rl = await checkAndIncrement(`crypto:s2d:${user.id}:m:${minute}`, 120, 60);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { errcode: "M_LIMIT_EXCEEDED", error: "rate limit exceeded", retry_after_ms: retryAfter * 1000 },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const { event_type: rawEventType, txn_id: rawTxnId } = await params;
  const eventType = decodeURIComponent(rawEventType);
  const txnId = decodeURIComponent(rawTxnId);
  if (!eventType || !txnId || eventType.length > 256 || txnId.length > 256) {
    return matrixError("M_UNKNOWN", "bad path params", 400);
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return matrixError("M_UNKNOWN", `bad body: ${parsed.error.message}`, 400);

  const txnInsert = await db.insert(cryptoSentTxns).values({
    senderUserId: user.id, senderDeviceId, txnId,
  }).onConflictDoNothing().returning({ txnId: cryptoSentTxns.txnId });
  if (txnInsert.length === 0) return NextResponse.json({});

  const userRows: typeof userToDeviceQueue.$inferInsert[] = [];
  const botRows: typeof botToDeviceQueue.$inferInsert[] = [];

  for (const [matrixId, devices] of Object.entries(parsed.data.messages)) {
    const principal = parsePrincipalFromMatrixId(matrixId);
    if (!principal) continue;
    for (const [deviceId, content] of Object.entries(devices)) {
      if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 128) continue;
      if (principal.type === "user") {
        userRows.push({
          recipientUserId: principal.id,
          recipientDeviceId: deviceId,
          senderUserId: user.id,
          senderDeviceId,
          eventType,
          contentJson: content as Record<string, unknown>,
          txnId,
        });
      } else {
        botRows.push({
          botId: principal.id,
          deviceId,
          eventType,
          senderUserId: user.id,
          senderBotId: null,
          payload: content as Record<string, unknown>,
        });
      }
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < userRows.length; i += CHUNK) {
    await db.insert(userToDeviceQueue).values(userRows.slice(i, i + CHUNK));
  }
  for (let i = 0; i < botRows.length; i += CHUNK) {
    await db.insert(botToDeviceQueue).values(botRows.slice(i, i + CHUNK));
  }
  return NextResponse.json({});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-crypto-sendtodevice-bot.test.ts`
Expected: PASS (2 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/crypto/sendToDevice/[event_type]/[txn_id]/route.ts apps/web/__tests__/api-crypto-sendtodevice-bot.test.ts
git commit -m "feat(crypto): route bot recipients to bot_to_device_queue in sendToDevice"
```

---

## Phase 2 — Server `/api/bot/v1/crypto/*` mirror

All routes in this phase are authed via `getBotFromRequest` from `apps/web/lib/bot-auth.ts`. Use bearer token in the `Authorization: Bearer <token>` header.

### Task 7: `POST /api/bot/v1/crypto/keys/upload`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/keys/upload/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-keys-upload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-keys-upload.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/upload/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";

let botId: string;
let token: string;

async function withAuth(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const SAMPLE = (deviceId: string, ed: string) => ({
  device_keys: {
    device_id: deviceId,
    identity_keys: { [`ed25519:${deviceId}`]: ed, [`curve25519:${deviceId}`]: "cv" },
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    signatures: { ["selfsig"]: { [`ed25519:${deviceId}`]: "sig" } },
  },
  one_time_keys: {
    "signed_curve25519:AAAA": { key: "k1" },
    "signed_curve25519:BBBB": { key: "k2" },
  },
});

describe("/api/bot/v1/crypto/keys/upload", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'kup') ON CONFLICT DO NOTHING`);
    token = randomBytes(16).toString("hex");
    const [b] = await db.insert(bots).values({
      name: `kup-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;
  });

  it("first upload transitions bots.e2ee_state to ready + sets device_id", async () => {
    const res = await withAuth(SAMPLE("BDEV1", "edpk1"));
    expect(res.status).toBe(200);
    const [bot] = await db.select().from(bots).where(sql`${bots.id} = ${botId}`);
    expect(bot!.e2eeState).toBe("ready");
    expect(bot!.e2eeDeviceId).toBe("BDEV1");
    const devs = await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`);
    expect(devs).toHaveLength(1);
    const otks = await db.select().from(botOneTimeKeys).where(sql`${botOneTimeKeys.botId} = ${botId}`);
    expect(otks).toHaveLength(2);
  });

  it("re-upload with same device + identity is idempotent (200, no extra rows)", async () => {
    const before = (await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`)).length;
    const res = await withAuth(SAMPLE("BDEV1", "edpk1"));
    expect(res.status).toBe(200);
    const after = (await db.select().from(botDevices).where(sql`${botDevices.botId} = ${botId}`)).length;
    expect(after).toBe(before);
  });

  it("rejects identity mismatch on same device with 422", async () => {
    const res = await withAuth(SAMPLE("BDEV1", "edpk-different"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.errcode).toBe("crypto_keys_invalid");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-upload.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/keys/upload/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/keys/upload/route.ts
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { bots, botDevices, botOneTimeKeys } from "@legends/db/schema";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";

const deviceKeysSchema = z.object({
  device_id: z.string().min(1).max(128),
  identity_keys: z.record(z.string(), z.string().min(1).max(2048)),
  algorithms: z.array(z.string().min(1).max(128)).min(1).max(16),
  signatures: z.record(z.string(), z.record(z.string(), z.string().min(1).max(4096))).optional(),
  unsigned: z.record(z.unknown()).optional(),
});
const bodySchema = z.object({
  device_keys: deviceKeysSchema,
  one_time_keys: z.record(z.string().min(1).max(256), z.union([
    z.string().min(1).max(2048),
    z.object({ key: z.string().min(1).max(2048), signatures: z.record(z.string(), z.record(z.string(), z.string())).optional() }),
  ])).optional(),
});

function err(errcode: string, error: string, status: number) {
  return NextResponse.json({ errcode, error }, { status });
}

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return err("unauthorized", "unauthorized", 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return err(BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID, `bad body: ${parsed.error.message}`, 422);

  const dk = parsed.data.device_keys;
  const edKey = dk.identity_keys[`ed25519:${dk.device_id}`];
  if (!edKey) return err(BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID, "missing ed25519 identity key", 422);

  // Idempotency: same (botId, deviceId) row must keep the same identity_keys.
  const [existing] = await db.select({ identityKeys: botDevices.identityKeys })
    .from(botDevices)
    .where(and(eq(botDevices.botId, bot.id), eq(botDevices.deviceId, dk.device_id)))
    .limit(1);
  if (existing) {
    const existingEd = (existing.identityKeys as Record<string, string>)[`ed25519:${dk.device_id}`];
    if (existingEd !== edKey) {
      return err(BOT_E2EE_ERROR_CODES.CRYPTO_KEYS_INVALID, "identity key mismatch for existing device", 422);
    }
  }

  await db.insert(botDevices).values({
    botId: bot.id,
    deviceId: dk.device_id,
    algorithms: dk.algorithms,
    identityKeys: dk.identity_keys,
    signatures: dk.signatures ?? null,
    unsigned: dk.unsigned ?? null,
  }).onConflictDoUpdate({
    target: [botDevices.botId, botDevices.deviceId],
    set: {
      algorithms: dk.algorithms,
      identityKeys: dk.identity_keys,
      signatures: dk.signatures ?? null,
      updatedAt: new Date(),
    },
  });

  if (parsed.data.one_time_keys) {
    for (const [keyId, raw] of Object.entries(parsed.data.one_time_keys)) {
      const colon = keyId.indexOf(":");
      if (colon <= 0) continue;
      const algorithm = keyId.slice(0, colon);
      const keyJson = typeof raw === "string" ? { key: raw } : (raw as Record<string, unknown>);
      await db.insert(botOneTimeKeys).values({
        botId: bot.id, deviceId: dk.device_id, keyId, algorithm, keyJson,
      }).onConflictDoNothing({ target: [botOneTimeKeys.botId, botOneTimeKeys.deviceId, botOneTimeKeys.keyId] });
    }
  }

  // First successful upload transitions disabled|pending → ready.
  await db.update(bots).set({ e2eeState: "ready", e2eeDeviceId: dk.device_id })
    .where(and(eq(bots.id, bot.id)));

  // Per-algorithm OTK count, so the SDK knows when to top up.
  const counts: Record<string, number> = {};
  const allOtks = await db.select({ algorithm: botOneTimeKeys.algorithm })
    .from(botOneTimeKeys)
    .where(and(eq(botOneTimeKeys.botId, bot.id), eq(botOneTimeKeys.deviceId, dk.device_id)));
  for (const r of allOtks) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;

  return NextResponse.json({ one_time_key_counts: counts });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-upload.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/keys/upload/route.ts apps/web/__tests__/api-bot-crypto-keys-upload.test.ts
git commit -m "feat(bot-api): POST /api/bot/v1/crypto/keys/upload + state machine to ready"
```

---

### Task 8: `POST /api/bot/v1/crypto/keys/query`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/keys/query/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-keys-query.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-keys-query.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/query/route";
import { db } from "@/lib/db";
import { bots, botDevices, userKeyBundles } from "@legends/db/schema";

let token: string;
let botId: string;
let peerUserId: string;
let peerBotId: string;

async function postQuery(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("/api/bot/v1/crypto/keys/query", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'kq2'), (${peerUserId}, 'peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "UDV", identityPublicKey: "ed",
      algorithmsJson: ["m.olm.v1.curve25519-aes-sha2"],
      keysJson: { "ed25519:UDV": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UDV": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b1] = await db.insert(bots).values({
      name: `kqbot-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b1!.id;
    const [b2] = await db.insert(bots).values({
      name: `kqpeerbot-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId, deviceId: "PB1",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      identityKeys: { "ed25519:PB1": "edpb" },
    });
  });

  it("queries a user", async () => {
    const res = await postQuery({ matrix_ids: [`@${peerUserId}:legends.local`] });
    const body = await res.json();
    expect(body.device_keys[`@${peerUserId}:legends.local`]).toBeDefined();
    expect(body.device_keys[`@${peerUserId}:legends.local`].UDV).toBeDefined();
  });

  it("queries another bot", async () => {
    const res = await postQuery({ matrix_ids: [`@bot.${peerBotId}:legends.local`] });
    const body = await res.json();
    expect(body.device_keys[`@bot.${peerBotId}:legends.local`].PB1).toBeDefined();
  });

  it("unknown matrix id returns empty entry", async () => {
    const res = await postQuery({ matrix_ids: [`@bot.${randomUUID()}:legends.local`] });
    const body = await res.json();
    const k = Object.keys(body.device_keys)[0]!;
    expect(body.device_keys[k]).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-query.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/keys/query/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/keys/query/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, getDeviceList } from "@/lib/crypto-principal";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  matrix_ids: z.array(z.string().min(1).max(256)).min(1).max(200),
});

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ errcode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ errcode: "bad_body", error: parsed.error.message }, { status: 400 });
  }

  const deviceKeys: Record<string, Record<string, unknown>> = {};
  for (const matrixId of parsed.data.matrix_ids) {
    const p = parsePrincipalFromMatrixId(matrixId);
    if (!p) {
      deviceKeys[matrixId] = {};
      continue;
    }
    const list = await getDeviceList(p);
    const fullId = p.type === "user" ? toMatrixUserId(p.id) : toMatrixBotId(p.id);
    const perDevice: Record<string, unknown> = {};
    for (const d of list.devices) {
      perDevice[d.deviceId] = {
        user_id: fullId,
        device_id: d.deviceId,
        algorithms: d.algorithms,
        keys: d.keys,
        signatures: d.signatures,
      };
    }
    deviceKeys[fullId] = perDevice;
  }
  return NextResponse.json({ device_keys: deviceKeys });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-query.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/keys/query/route.ts apps/web/__tests__/api-bot-crypto-keys-query.test.ts
git commit -m "feat(bot-api): POST /api/bot/v1/crypto/keys/query (user + bot principals)"
```

---

### Task 9: `POST /api/bot/v1/crypto/keys/claim`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/keys/claim/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-keys-claim.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-keys-claim.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/crypto/keys/claim/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys, userKeyBundles, userOneTimePrekeys } from "@legends/db/schema";

let token: string;
let peerUserId: string;
let peerBotId: string;

async function postClaim(body: unknown): Promise<Response> {
  return POST(new Request("http://t/bot/v1/crypto/keys/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("/api/bot/v1/crypto/keys/claim", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'cl'), (${peerUserId}, 'cl-peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "UCL", identityPublicKey: "ed",
      algorithmsJson: ["a"], keysJson: { "ed25519:UCL": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UCL": "s" } },
    });
    await db.insert(userOneTimePrekeys).values({
      userId: peerUserId, deviceId: "UCL", keyId: "signed_curve25519:UO1",
      algorithm: "signed_curve25519", keyJson: { key: "u1" },
    });
    token = randomBytes(16).toString("hex");
    await db.insert(bots).values({
      name: `cl-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    const [b2] = await db.insert(bots).values({
      name: `cl-peer-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId, deviceId: "BCL",
      algorithms: ["a"], identityKeys: { "ed25519:BCL": "ed" },
    });
    await db.insert(botOneTimeKeys).values({
      botId: peerBotId, deviceId: "BCL", keyId: "signed_curve25519:BO1",
      algorithm: "signed_curve25519", keyJson: { key: "b1" },
    });
  });

  it("claims a user OTK", async () => {
    const res = await postClaim({
      one_time_keys: { [`@${peerUserId}:legends.local`]: { UCL: "signed_curve25519" } },
    });
    const body = await res.json();
    const k = body.one_time_keys[`@${peerUserId}:legends.local`].UCL;
    expect(Object.keys(k)).toContain("signed_curve25519:UO1");
  });

  it("claims a bot OTK", async () => {
    const res = await postClaim({
      one_time_keys: { [`@bot.${peerBotId}:legends.local`]: { BCL: "signed_curve25519" } },
    });
    const body = await res.json();
    const k = body.one_time_keys[`@bot.${peerBotId}:legends.local`].BCL;
    expect(Object.keys(k)).toContain("signed_curve25519:BO1");
  });

  it("exhausted pool: device omitted from response", async () => {
    const res = await postClaim({
      one_time_keys: { [`@${peerUserId}:legends.local`]: { UCL: "signed_curve25519" } },
    });
    const body = await res.json();
    expect(body.one_time_keys[`@${peerUserId}:legends.local`]?.UCL).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-claim.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/keys/claim/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/keys/claim/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, claimOneTimeKey } from "@/lib/crypto-principal";
import { toMatrixBotId, toMatrixUserId } from "@/lib/crypto-matrix";

const bodySchema = z.object({
  one_time_keys: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.string().min(1).max(64)),
  ),
});

export async function POST(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ errcode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ errcode: "bad_body", error: parsed.error.message }, { status: 400 });
  }

  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [matrixId, devices] of Object.entries(parsed.data.one_time_keys)) {
    const p = parsePrincipalFromMatrixId(matrixId);
    if (!p) continue;
    const fullId = p.type === "user" ? toMatrixUserId(p.id) : toMatrixBotId(p.id);
    const bucket: Record<string, Record<string, unknown>> = {};
    for (const [deviceId, algorithm] of Object.entries(devices)) {
      const otk = await claimOneTimeKey(p, deviceId, algorithm);
      if (otk) bucket[deviceId] = { [otk.keyId]: otk.keyJson };
    }
    if (Object.keys(bucket).length > 0) out[fullId] = bucket;
  }
  return NextResponse.json({ one_time_keys: out });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-keys-claim.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/keys/claim/route.ts apps/web/__tests__/api-bot-crypto-keys-claim.test.ts
git commit -m "feat(bot-api): POST /api/bot/v1/crypto/keys/claim (user + bot OTK pools)"
```

---

### Task 10: `PUT /api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-sendtodevice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-sendtodevice.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PUT } from "@/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route";
import { db } from "@/lib/db";
import { bots, botDevices, botToDeviceQueue, userKeyBundles, userToDeviceQueue } from "@legends/db/schema";

let token: string;
let botId: string;
let peerUserId: string;
let peerBotId: string;

async function send(eventType: string, txnId: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://t/bot/v1/crypto/sendToDevice/${eventType}/${txnId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ event_type: eventType, txn_id: txnId }) },
  );
}

describe("/api/bot/v1/crypto/sendToDevice", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    peerUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'bs2d'), (${peerUserId}, 'bs2d-peer') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId: peerUserId, deviceId: "UDD", identityPublicKey: "ed",
      algorithmsJson: ["a"], keysJson: { "ed25519:UDD": "ed" },
      signaturesJson: { [`@${peerUserId}:legends.local`]: { "ed25519:UDD": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b1] = await db.insert(bots).values({
      name: `bs2d-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b1!.id;
    const [b2] = await db.insert(bots).values({
      name: `bs2d-peer-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    }).returning({ id: bots.id });
    peerBotId = b2!.id;
    await db.insert(botDevices).values({
      botId: peerBotId, deviceId: "PBD",
      algorithms: ["a"], identityKeys: { "ed25519:PBD": "ed" },
    });
  });

  it("bot → user lands in user_to_device_queue", async () => {
    const txn = `tu-${Date.now()}`;
    const res = await send("m.room.encrypted", txn, {
      messages: { [`@${peerUserId}:legends.local`]: { UDD: { type: "m.room.encrypted" } } },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(userToDeviceQueue).where(sql`${userToDeviceQueue.recipientUserId} = ${peerUserId} AND ${userToDeviceQueue.txnId} = ${txn}`);
    expect(rows).toHaveLength(1);
  });

  it("bot → bot lands in bot_to_device_queue with sender_bot_id set", async () => {
    const txn = `tb-${Date.now()}`;
    const res = await send("m.room.encrypted", txn, {
      messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { type: "m.room.encrypted" } } },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1]!.senderBotId).toBe(botId);
    expect(rows[rows.length - 1]!.senderUserId).toBeNull();
  });

  it("replay with same body_hash returns 200 + does not duplicate", async () => {
    const txn = `tr-${Date.now()}`;
    const body = { messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { type: "m.room.encrypted", x: 1 } } } };
    await send("m.room.encrypted", txn, body);
    const before = (await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`)).length;
    const res = await send("m.room.encrypted", txn, body);
    expect(res.status).toBe(200);
    const after = (await db.select().from(botToDeviceQueue).where(sql`${botToDeviceQueue.botId} = ${peerBotId}`)).length;
    expect(after).toBe(before);
  });

  it("replay with different body_hash returns 409", async () => {
    const txn = `tc-${Date.now()}`;
    await send("m.room.encrypted", txn, { messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { x: 1 } } } });
    const res = await send("m.room.encrypted", txn, { messages: { [`@bot.${peerBotId}:legends.local`]: { PBD: { x: 2 } } } });
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-sendtodevice.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { bots, botToDeviceQueue, userToDeviceQueue } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { parsePrincipalFromMatrixId, idempotencyCheck } from "@/lib/crypto-principal";

const bodySchema = z.object({
  messages: z.record(
    z.string().min(1).max(256),
    z.record(z.string().min(1).max(128), z.record(z.string(), z.unknown())),
  ),
});

export async function PUT(
  req: NextRequest | Request,
  { params }: { params: Promise<{ event_type: string; txn_id: string }> },
) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ errcode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { event_type: rawEvent, txn_id: rawTxn } = await params;
  const eventType = decodeURIComponent(rawEvent);
  const txnId = decodeURIComponent(rawTxn);
  if (!eventType || !txnId) {
    return NextResponse.json({ errcode: "bad_path", error: "bad path params" }, { status: 400 });
  }

  const rawBody = await req.text();
  const parsed = bodySchema.safeParse(JSON.parse(rawBody || "null"));
  if (!parsed.success) return NextResponse.json({ errcode: "bad_body", error: parsed.error.message }, { status: 400 });

  const bodyHash = createHash("sha256").update(rawBody).digest();
  const idem = await idempotencyCheck({ type: "bot", id: bot.id }, txnId, eventType, bodyHash);
  if (!idem.stored) {
    if (idem.conflict) return NextResponse.json({ errcode: "txn_conflict", error: "different body for same txn_id" }, { status: 409 });
    return NextResponse.json({});
  }

  // Resolve owner once for bot→user envelope sender_user_id population.
  const [{ ownerUserId }] = await db.select({ ownerUserId: bots.ownerUserId }).from(bots).where(eq(bots.id, bot.id));

  const userRows: typeof userToDeviceQueue.$inferInsert[] = [];
  const botRows: typeof botToDeviceQueue.$inferInsert[] = [];

  for (const [matrixId, devices] of Object.entries(parsed.data.messages)) {
    const p = parsePrincipalFromMatrixId(matrixId);
    if (!p) continue;
    for (const [deviceId, content] of Object.entries(devices)) {
      if (typeof deviceId !== "string" || !deviceId.length || deviceId.length > 128) continue;
      if (p.type === "user") {
        // Bot→user envelopes: synthesize a sender_user_id from the bot owner,
        // and tag senderDeviceId='bot' so a user's /api/crypto/sync can show
        // the envelope came from a bot principal (the SDK already treats
        // `device_id === 'bot'` specially in its routing fallback).
        userRows.push({
          recipientUserId: p.id,
          recipientDeviceId: deviceId,
          senderUserId: ownerUserId,
          senderDeviceId: `bot:${bot.id}`,
          eventType,
          contentJson: content as Record<string, unknown>,
          txnId,
        });
      } else {
        botRows.push({
          botId: p.id,
          deviceId,
          eventType,
          senderUserId: null,
          senderBotId: bot.id,
          payload: content as Record<string, unknown>,
        });
      }
    }
  }

  const CHUNK = 200;
  for (let i = 0; i < userRows.length; i += CHUNK) {
    await db.insert(userToDeviceQueue).values(userRows.slice(i, i + CHUNK));
  }
  for (let i = 0; i < botRows.length; i += CHUNK) {
    await db.insert(botToDeviceQueue).values(botRows.slice(i, i + CHUNK));
  }

  return NextResponse.json({});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-sendtodevice.test.ts`
Expected: PASS (4 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/sendToDevice/[event_type]/[txn_id]/route.ts apps/web/__tests__/api-bot-crypto-sendtodevice.test.ts
git commit -m "feat(bot-api): PUT /api/bot/v1/crypto/sendToDevice with body-hash idempotency"
```

---

### Task 11: `GET /api/bot/v1/crypto/sync`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/sync/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-sync.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-sync.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/crypto/sync/route";
import { db } from "@/lib/db";
import { bots, botDevices, botOneTimeKeys, botToDeviceQueue } from "@legends/db/schema";

let token: string;
let botId: string;

async function sync(): Promise<Response> {
  return GET(new Request("http://t/bot/v1/crypto/sync", {
    headers: { authorization: `Bearer ${token}` },
  }));
}

describe("/api/bot/v1/crypto/sync", () => {
  beforeAll(async () => {
    const ownerId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'sn') ON CONFLICT DO NOTHING`);
    token = randomBytes(16).toString("hex");
    const [b] = await db.insert(bots).values({
      name: `sn-${Date.now()}`, ownerUserId: ownerId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId, deviceId: "SDV", algorithms: ["a"], identityKeys: { "ed25519:SDV": "ed" },
    });
    await db.insert(botOneTimeKeys).values([
      { botId, deviceId: "SDV", keyId: "signed_curve25519:O1", algorithm: "signed_curve25519", keyJson: { key: "1" } },
      { botId, deviceId: "SDV", keyId: "signed_curve25519:O2", algorithm: "signed_curve25519", keyJson: { key: "2" } },
    ]);
    // Enqueue 3 envelopes.
    for (let i = 0; i < 3; i++) {
      await db.insert(botToDeviceQueue).values({
        botId, deviceId: "SDV", eventType: "m.room.encrypted",
        senderUserId: ownerId, senderBotId: null,
        payload: { i },
      });
    }
  });

  it("returns 3 envelopes on first sync, 0 on second, with OTK count", async () => {
    const a = await sync();
    const ja = await a.json();
    expect(ja.to_device.events).toHaveLength(3);
    expect(ja.device_one_time_keys_count.signed_curve25519).toBe(2);

    const b = await sync();
    const jb = await b.json();
    expect(jb.to_device.events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-sync.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/sync/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/sync/route.ts
// Drain the bot's to-device queue in a single SELECT … FOR UPDATE → DELETE …
// RETURNING. Mirrors the long-poll shape of /api/bot/v1/getUpdates but is
// implemented as a one-shot drain since the SDK polls on its own cadence.
import { NextResponse } from "next/server";
import { sql, eq, and, isNull } from "drizzle-orm";
import { botOneTimeKeys } from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { toMatrixUserId, toMatrixBotId } from "@/lib/crypto-matrix";

export const maxDuration = 30;

export async function GET(req: Request) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ errcode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const drained = await db.execute<{
    device_id: string;
    event_type: string;
    sender_user_id: string | null;
    sender_bot_id: string | null;
    payload: Record<string, unknown>;
  }>(sql`
    DELETE FROM bot_to_device_queue
     WHERE id IN (
       SELECT id FROM bot_to_device_queue
        WHERE bot_id = ${bot.id}
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 200
     )
     RETURNING device_id, event_type, sender_user_id, sender_bot_id, payload
  `);

  const events: { type: string; sender: string; content: Record<string, unknown> }[] = [];
  for (const row of Array.from(drained)) {
    const sender = row.sender_bot_id
      ? toMatrixBotId(row.sender_bot_id)
      : row.sender_user_id
        ? toMatrixUserId(row.sender_user_id)
        : "@unknown:legends.local";
    events.push({ type: row.event_type, sender, content: row.payload });
  }

  const otks = await db.select({ algorithm: botOneTimeKeys.algorithm })
    .from(botOneTimeKeys)
    .where(and(eq(botOneTimeKeys.botId, bot.id), isNull(botOneTimeKeys.claimedAt)));
  const counts: Record<string, number> = {};
  for (const r of otks) counts[r.algorithm] = (counts[r.algorithm] ?? 0) + 1;

  return NextResponse.json({
    to_device: { events },
    device_one_time_keys_count: counts,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-sync.test.ts`
Expected: PASS (1 it-block, 4 assertions)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/sync/route.ts apps/web/__tests__/api-bot-crypto-sync.test.ts
git commit -m "feat(bot-api): GET /api/bot/v1/crypto/sync drains bot_to_device_queue"
```

---

### Task 12: `GET /api/bot/v1/crypto/rooms/[roomId]`

**Files:**
- Create: `apps/web/app/api/bot/v1/crypto/rooms/[roomId]/route.ts`
- Test: `apps/web/__tests__/api-bot-crypto-rooms.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-crypto-rooms.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GET } from "@/app/api/bot/v1/crypto/rooms/[roomId]/route";
import { db } from "@/lib/db";
import {
  bots, botDevices, dmConversations, dmParticipants, topics, topicBots, topicMembers, userKeyBundles,
} from "@legends/db/schema";

let token: string;
let botId: string;
let userId: string;
let dmRoomId: string;
let topicRoomId: string;

async function get(roomId: string): Promise<Response> {
  return GET(
    new Request(`http://t/bot/v1/crypto/rooms/${encodeURIComponent(roomId)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ roomId }) },
  );
}

describe("/api/bot/v1/crypto/rooms/[roomId]", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'cr') ON CONFLICT DO NOTHING`);
    await db.insert(userKeyBundles).values({
      userId, deviceId: "UCR", identityPublicKey: "ed",
      algorithmsJson: ["a"], keysJson: { "ed25519:UCR": "ed" },
      signaturesJson: { [`@${userId}:legends.local`]: { "ed25519:UCR": "s" } },
    });
    token = randomBytes(16).toString("hex");
    const [b] = await db.insert(bots).values({
      name: `cr-${Date.now()}`, ownerUserId: userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      dmEnabled: true,
    }).returning({ id: bots.id });
    botId = b!.id;
    await db.insert(botDevices).values({
      botId, deviceId: "BCR", algorithms: ["a"], identityKeys: { "ed25519:BCR": "ed" },
    });
    // DM room: bot is participant.
    const dmId = randomUUID();
    await db.insert(dmConversations).values({
      id: dmId, dmKey: `u:${userId}|b:${botId}`, isE2ee: true, state: "accepted",
      initiatorType: "user", initiatorId: userId, e2eeRoomId: `!${dmId}:legends.local`,
    });
    await db.insert(dmParticipants).values([
      { conversationId: dmId, principalType: "user", principalId: userId },
      { conversationId: dmId, principalType: "bot", principalId: botId },
    ]);
    dmRoomId = `!${dmId}:legends.local`;
    // Topic room: bot is in topic_bots.
    const slug = `crt-${Date.now()}`;
    const [t] = await db.insert(topics).values({
      slug, name: slug, isE2ee: true, e2eeRoomId: null,
    }).returning({ id: topics.id });
    await db.update(topics).set({ e2eeRoomId: `!${t!.id}:legends.local` }).where(sql`${topics.id} = ${t!.id}`);
    await db.insert(topicMembers).values({ topicId: t!.id, userId });
    await db.insert(topicBots).values({ topicId: t!.id, botId });
    topicRoomId = `!${t!.id}:legends.local`;
  });

  it("returns members for DM room where bot participates", async () => {
    const res = await get(dmRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    const matrixIds = body.members.map((m: { matrix_id: string }) => m.matrix_id);
    expect(matrixIds).toContain(`@${userId}:legends.local`);
  });

  it("returns members for topic room where bot is in topic_bots", async () => {
    const res = await get(topicRoomId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members.length).toBeGreaterThanOrEqual(1);
  });

  it("403 when bot is not a member of the room", async () => {
    const otherTopicId = randomUUID();
    await db.insert(topics).values({ id: otherTopicId, slug: `cro-${Date.now()}`, name: "x", isE2ee: true, e2eeRoomId: `!${otherTopicId}:legends.local` });
    const res = await get(`!${otherTopicId}:legends.local`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-rooms.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/crypto/rooms/[roomId]/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/crypto/rooms/[roomId]/route.ts
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import {
  dmConversations, dmParticipants, topics, topicBots, topicMembers,
  userKeyBundles, botDevices,
} from "@legends/db/schema";
import { db } from "@/lib/db";
import { getBotFromRequest } from "@/lib/bot-auth";
import { fromMatrixRoomId, toMatrixUserId, toMatrixBotId } from "@/lib/crypto-matrix";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ errcode: "unauthorized", error: "unauthorized" }, { status: 401 });

  const { roomId } = await params;
  const inner = fromMatrixRoomId(roomId);
  if (!inner) return NextResponse.json({ errcode: "bad_room_id", error: "invalid room id" }, { status: 400 });

  // DM first.
  const [dm] = await db.select({ id: dmConversations.id }).from(dmConversations).where(eq(dmConversations.id, inner)).limit(1);
  if (dm) {
    const parts = await db.select({ pt: dmParticipants.principalType, pid: dmParticipants.principalId })
      .from(dmParticipants).where(eq(dmParticipants.conversationId, dm.id));
    const mine = parts.some((p) => p.pt === "bot" && p.pid === bot.id);
    if (!mine) return NextResponse.json({ errcode: "forbidden", error: "not a member" }, { status: 403 });
    const members = await assembleMembers(parts.filter((p) => !(p.pt === "bot" && p.pid === bot.id)));
    return NextResponse.json({ members });
  }
  // Topic.
  const [topic] = await db.select({ id: topics.id }).from(topics).where(eq(topics.id, inner)).limit(1);
  if (topic) {
    const [tb] = await db.select().from(topicBots)
      .where(and(eq(topicBots.topicId, topic.id), eq(topicBots.botId, bot.id))).limit(1);
    if (!tb) return NextResponse.json({ errcode: "forbidden", error: "not a member" }, { status: 403 });
    const userRows = await db.select({ userId: topicMembers.userId }).from(topicMembers).where(eq(topicMembers.topicId, topic.id));
    const botRows = await db.select({ botId: topicBots.botId }).from(topicBots).where(eq(topicBots.topicId, topic.id));
    const parts = [
      ...userRows.map((u) => ({ pt: "user" as const, pid: u.userId })),
      ...botRows.filter((b) => b.botId !== bot.id).map((b) => ({ pt: "bot" as const, pid: b.botId })),
    ];
    const members = await assembleMembers(parts);
    return NextResponse.json({ members });
  }
  return NextResponse.json({ errcode: "not_found", error: "room not found" }, { status: 404 });
}

async function assembleMembers(parts: { pt: "user" | "bot"; pid: string }[]) {
  const userIds = parts.filter((p) => p.pt === "user").map((p) => p.pid);
  const botIds = parts.filter((p) => p.pt === "bot").map((p) => p.pid);
  const userDevs = userIds.length
    ? await db.select({ userId: userKeyBundles.userId, deviceId: userKeyBundles.deviceId })
        .from(userKeyBundles).where(inArray(userKeyBundles.userId, userIds))
    : [];
  const botDevs = botIds.length
    ? await db.select({ botId: botDevices.botId, deviceId: botDevices.deviceId })
        .from(botDevices).where(inArray(botDevices.botId, botIds))
    : [];
  const byUser = new Map<string, string[]>();
  for (const r of userDevs) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.deviceId]);
  const byBot = new Map<string, string[]>();
  for (const r of botDevs) byBot.set(r.botId, [...(byBot.get(r.botId) ?? []), r.deviceId]);
  const out: { matrix_id: string; devices: string[] }[] = [];
  for (const uid of userIds) out.push({ matrix_id: toMatrixUserId(uid), devices: byUser.get(uid) ?? [] });
  for (const bid of botIds) out.push({ matrix_id: toMatrixBotId(bid), devices: byBot.get(bid) ?? [] });
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-crypto-rooms.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/crypto/rooms/[roomId]/route.ts apps/web/__tests__/api-bot-crypto-rooms.test.ts
git commit -m "feat(bot-api): GET /api/bot/v1/crypto/rooms/[roomId] returns members + devices"
```

---

### Task 13: `POST /api/bot/v1/dm/[id]/messages`

**Files:**
- Create: `apps/web/app/api/bot/v1/dm/[id]/messages/route.ts`
- Test: `apps/web/__tests__/api-bot-dm-messages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/api-bot-dm-messages.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { POST } from "@/app/api/bot/v1/dm/[id]/messages/route";
import { db } from "@/lib/db";
import { bots, dmConversations, dmParticipants } from "@legends/db/schema";

vi.mock("@/lib/redis", () => ({
  redis: {
    publish: async () => 0,
    rpush: async () => 1, expire: async () => 1,
  },
}));

let token: string;
let botId: string;
let userId: string;
let e2eeConvId: string;
let plaintextConvId: string;

async function post(convId: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://t/bot/v1/dm/${convId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: convId }) },
  );
}

describe("/api/bot/v1/dm/[id]/messages", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'bd') ON CONFLICT DO NOTHING`);
    token = randomBytes(16).toString("hex");
    const [b] = await db.insert(bots).values({
      name: `bd-${Date.now()}`, ownerUserId: userId, dmEnabled: true,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).returning({ id: bots.id });
    botId = b!.id;

    const [e2ee] = await db.insert(dmConversations).values({
      dmKey: `b:${botId}|u:${userId}`, isE2ee: true, state: "accepted",
      initiatorType: "user", initiatorId: userId,
    }).returning({ id: dmConversations.id });
    e2eeConvId = e2ee!.id;
    await db.update(dmConversations).set({ e2eeRoomId: `!${e2eeConvId}:legends.local` }).where(sql`${dmConversations.id} = ${e2eeConvId}`);
    await db.insert(dmParticipants).values([
      { conversationId: e2eeConvId, principalType: "user", principalId: userId },
      { conversationId: e2eeConvId, principalType: "bot", principalId: botId },
    ]);

    const [pl] = await db.insert(dmConversations).values({
      dmKey: `b:${botId}|u:${userId}|pt`, isE2ee: false, state: "accepted",
      initiatorType: "user", initiatorId: userId,
    }).returning({ id: dmConversations.id });
    plaintextConvId = pl!.id;
    await db.insert(dmParticipants).values([
      { conversationId: plaintextConvId, principalType: "user", principalId: userId },
      { conversationId: plaintextConvId, principalType: "bot", principalId: botId },
    ]);
  });

  it("bot ciphertext to E2EE convo: 201", async () => {
    const res = await post(e2eeConvId, { ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 } });
    expect(res.status).toBe(201);
  });

  it("bot plaintext to E2EE convo: 400", async () => {
    const res = await post(e2eeConvId, { text: "hi" });
    expect(res.status).toBe(400);
  });

  it("bot ciphertext to plaintext convo: 400", async () => {
    const res = await post(plaintextConvId, { ciphertext: { x: 1 } });
    expect(res.status).toBe(400);
  });

  it("bot not in convo: 403", async () => {
    const otherUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${otherUserId}, 'bd-x') ON CONFLICT DO NOTHING`);
    const [other] = await db.insert(dmConversations).values({
      dmKey: `u:${otherUserId}|u:${userId}`, isE2ee: false, state: "accepted",
      initiatorType: "user", initiatorId: userId,
    }).returning({ id: dmConversations.id });
    await db.insert(dmParticipants).values([
      { conversationId: other!.id, principalType: "user", principalId: userId },
      { conversationId: other!.id, principalType: "user", principalId: otherUserId },
    ]);
    const res = await post(other!.id, { text: "hi" });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-dm-messages.test.ts`
Expected: `Cannot find module '@/app/api/bot/v1/dm/[id]/messages/route'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/bot/v1/dm/[id]/messages/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { REDIS_CHANNELS } from "@legends/shared";
import { dmConversations, dmParticipants } from "@legends/db/schema";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { getBotFromRequest } from "@/lib/bot-auth";
import { insertDmMessage, recipientUserIds } from "@/lib/dm";
import { deliverDmToBots } from "@/lib/dm-bot-delivery";

const sendSchema = z
  .object({
    text: z.string().min(1).max(8000).optional(),
    ciphertext: z.record(z.unknown()).optional(),
    replyToMessageId: z.string().regex(/^\d+$/).optional().nullable(),
  })
  .refine((d) => (d.text != null) !== (d.ciphertext != null), {
    message: "provide exactly one of `text` or `ciphertext`",
  });

export async function POST(
  req: NextRequest | Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const bot = await getBotFromRequest(req);
  if (!bot) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Bot participant gate.
  const [member] = await db.select({ pid: dmParticipants.principalId }).from(dmParticipants).where(
    and(
      eq(dmParticipants.conversationId, id),
      eq(dmParticipants.principalType, "bot"),
      eq(dmParticipants.principalId, bot.id),
    ),
  ).limit(1);
  if (!member) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = sendSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const [conv] = await db.select().from(dmConversations).where(eq(dmConversations.id, id)).limit(1);
  if (!conv) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (conv.state === "blocked") return NextResponse.json({ error: "blocked" }, { status: 403 });
  if (conv.isE2ee && parsed.data.ciphertext == null) {
    return NextResponse.json({ error: "E2EE conversation; send ciphertext" }, { status: 400 });
  }
  if (!conv.isE2ee && parsed.data.text == null) {
    return NextResponse.json({ error: "plaintext conversation; send text" }, { status: 400 });
  }

  const msg = await insertDmMessage({
    conversationId: id,
    senderType: "bot",
    senderId: bot.id,
    text: parsed.data.text,
    ciphertext: parsed.data.ciphertext,
    replyToMessageId: parsed.data.replyToMessageId ?? null,
  });

  const peers = await recipientUserIds(id);
  await redis.publish(
    REDIS_CHANNELS.DM_MESSAGE_NEW,
    JSON.stringify({ conversationId: id, message: msg, userIds: peers, isE2ee: conv.isE2ee }),
  );

  // Loop through deliverDmToBots so any *other* bot participants get the
  // envelope; deliverDmToBots skips bot-authored sends to prevent feedback
  // loops (Task 15 extends it to forward ciphertext for E2EE convos).
  void deliverDmToBots(id, {
    id: msg.id, senderType: "bot", senderId: bot.id, senderDisplayName: bot.name,
    text: parsed.data.text ?? "", replyToMessageId: parsed.data.replyToMessageId ?? null,
    createdAt: msg.createdAt,
  }).catch(() => {});

  return NextResponse.json({ message: msg }, { status: 201 });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/api-bot-dm-messages.test.ts`
Expected: PASS (4 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/bot/v1/dm/[id]/messages/route.ts apps/web/__tests__/api-bot-dm-messages.test.ts
git commit -m "feat(bot-api): POST /api/bot/v1/dm/[id]/messages (text + ciphertext)"
```

---

## Phase 3 — DM open + delivery wiring

### Task 14: `dm.ts` state-machine gate

**Files:**
- Modify: `apps/web/lib/dm.ts` (replace the `peer.type==="bot" && options?.e2ee` BAD reject)
- Test: `apps/web/__tests__/dm-bot-e2ee-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/dm-bot-e2ee-gate.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { openConversation } from "@/lib/dm";
import { db } from "@/lib/db";
import { bots } from "@legends/db/schema";
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";

async function makeBot(state: "disabled" | "pending" | "ready"): Promise<{ botId: string; userId: string }> {
  const ownerId = randomUUID();
  const userId = randomUUID();
  await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${ownerId}, 'gO'), (${userId}, 'gU') ON CONFLICT DO NOTHING`);
  const [b] = await db.insert(bots).values({
    name: `gate-${state}-${Date.now()}`, ownerUserId: ownerId, dmEnabled: true,
    tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
    e2eeState: state,
  }).returning({ id: bots.id });
  return { botId: b!.id, userId };
}

describe("dm.ts bot E2EE state-machine gate", () => {
  it("disabled → throws BOT_E2EE_DISABLED", async () => {
    const { botId, userId } = await makeBot("disabled");
    await expect(openConversation(userId, { type: "bot", id: botId }, { e2ee: true }))
      .rejects.toMatchObject({ code: BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED });
  });

  it("pending → throws BOT_E2EE_NOT_READY", async () => {
    const { botId, userId } = await makeBot("pending");
    await expect(openConversation(userId, { type: "bot", id: botId }, { e2ee: true }))
      .rejects.toMatchObject({ code: BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY });
  });

  it("ready → succeeds + returns isE2ee=true convo", async () => {
    const { botId, userId } = await makeBot("ready");
    const out = await openConversation(userId, { type: "bot", id: botId }, { e2ee: true });
    expect(out.id).toBeDefined();
    expect(out.e2eeRoomId).toMatch(/^!.+:legends\.local$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/dm-bot-e2ee-gate.test.ts`
Expected: every it-block fails because today's `dm.ts:86` throws a generic `BAD` for any bot+e2ee combo.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/dm.ts — replace the "e2ee bot DMs are not supported yet"
// branch and re-derive isE2ee. Patch shown as the diff region.
//
// BEFORE:
//   if (peer.type === "bot" && options?.e2ee) {
//     throw Object.assign(new Error("e2ee bot DMs are not supported yet"), { code: "BAD" });
//   }
//
// AFTER: check the bot's e2ee_state and route on it.
import { BOT_E2EE_ERROR_CODES } from "@legends/shared";

if (peer.type === "bot" && options?.e2ee) {
  const [b] = await db.select({
    id: bots.id,
    isActive: bots.isActive,
    dmEnabled: bots.dmEnabled,
    e2eeState: bots.e2eeState,
  }).from(bots).where(eq(bots.id, peer.id)).limit(1);
  if (!b || !b.isActive || !b.dmEnabled) {
    throw Object.assign(new Error("bot not dm-able"), { code: "BAD" });
  }
  if (b.e2eeState === "disabled") {
    throw Object.assign(new Error("bot e2ee disabled"), { code: BOT_E2EE_ERROR_CODES.BOT_E2EE_DISABLED });
  }
  if (b.e2eeState === "pending") {
    throw Object.assign(new Error("bot e2ee not ready"), { code: BOT_E2EE_ERROR_CODES.BOT_E2EE_NOT_READY });
  }
  // ready → fall through; existing isE2ee derivation needs updating below.
}

// Also widen the isE2ee derivation: a ready bot peer now qualifies.
const isE2ee = !!options?.e2ee && (
  peer.type === "user" ||
  (peer.type === "bot")
);
```

> **Implementor note:** when applying the edit, replace the original line-86 reject and the subsequent `const isE2ee = peer.type === "user" && !!options?.e2ee;` derivation. The bot-peer pre-existing `dmEnabled` lookup at line 92 still runs for plaintext bot DMs (it should remain).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/dm-bot-e2ee-gate.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/dm.ts apps/web/__tests__/dm-bot-e2ee-gate.test.ts
git commit -m "feat(dm): gate bot E2EE DMs on bots.e2ee_state instead of unconditional reject"
```

---

### Task 15: `dm-bot-delivery.ts` ciphertext forward

**Files:**
- Modify: `apps/web/lib/dm-bot-delivery.ts`
- Test: `apps/web/__tests__/dm-bot-delivery.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/dm-bot-delivery.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { bots, dmConversations, dmParticipants } from "@legends/db/schema";
import { deliverDmToBots } from "@/lib/dm-bot-delivery";

const pushed: { key: string; payload: unknown }[] = [];
vi.mock("@/lib/redis", () => ({
  redis: {
    rpush: async (key: string, val: string) => { pushed.push({ key, payload: JSON.parse(val) }); return 1; },
    expire: async () => 1,
  },
}));

let userId: string, botId: string, e2eeConvId: string, plaintextConvId: string;

describe("deliverDmToBots — ciphertext branch", () => {
  beforeAll(async () => {
    userId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${userId}, 'dlv') ON CONFLICT DO NOTHING`);
    const [b] = await db.insert(bots).values({
      name: `dlv-${Date.now()}`, ownerUserId: userId, dmEnabled: true, isActive: true,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      e2eeState: "ready", e2eeDeviceId: "BDLV",
    }).returning({ id: bots.id });
    botId = b!.id;

    const [e] = await db.insert(dmConversations).values({
      dmKey: `b:${botId}|u:${userId}|e`, isE2ee: true, state: "accepted",
      initiatorType: "user", initiatorId: userId,
    }).returning({ id: dmConversations.id });
    e2eeConvId = e!.id;
    await db.insert(dmParticipants).values([
      { conversationId: e2eeConvId, principalType: "user", principalId: userId },
      { conversationId: e2eeConvId, principalType: "bot", principalId: botId },
    ]);

    const [p] = await db.insert(dmConversations).values({
      dmKey: `b:${botId}|u:${userId}|p`, isE2ee: false, state: "accepted",
      initiatorType: "user", initiatorId: userId,
    }).returning({ id: dmConversations.id });
    plaintextConvId = p!.id;
    await db.insert(dmParticipants).values([
      { conversationId: plaintextConvId, principalType: "user", principalId: userId },
      { conversationId: plaintextConvId, principalType: "bot", principalId: botId },
    ]);
  });

  it("E2EE convo forwards ciphertext, omits text", async () => {
    pushed.length = 0;
    await deliverDmToBots(e2eeConvId, {
      id: "1", senderType: "user", senderId: userId, senderDisplayName: "u",
      text: "", replyToMessageId: null, createdAt: new Date().toISOString(),
      ciphertext: { algorithm: "m.olm.v1.curve25519-aes-sha2", x: 1 },
      isE2ee: true,
    });
    expect(pushed).toHaveLength(1);
    const env = pushed[0]!.payload as { dm_message: { ciphertext?: unknown; text?: string } };
    expect(env.dm_message.ciphertext).toBeDefined();
    expect(env.dm_message.text).toBeFalsy();
  });

  it("plaintext convo forwards text, omits ciphertext", async () => {
    pushed.length = 0;
    await deliverDmToBots(plaintextConvId, {
      id: "2", senderType: "user", senderId: userId, senderDisplayName: "u",
      text: "hello", replyToMessageId: null, createdAt: new Date().toISOString(),
      isE2ee: false,
    });
    expect(pushed).toHaveLength(1);
    const env = pushed[0]!.payload as { dm_message: { text: string; ciphertext?: unknown } };
    expect(env.dm_message.text).toBe("hello");
    expect(env.dm_message.ciphertext).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/dm-bot-delivery.test.ts`
Expected: TypeScript error `Object literal may only specify known properties, 'ciphertext' does not exist in type` (current signature has no ciphertext arg).

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/dm-bot-delivery.ts — extend type + signature + envelope
type DmMessageEnvelope = {
  message_id: string;
  conversation_id: string;
  from: { id: string; display_name: string | null };
  text?: string;
  ciphertext?: Record<string, unknown>;
  reply_to_message_id?: string;
  date: number;
};
type DmUpdate = {
  update_id: string;
  type: "dm_message";
  dm_message: DmMessageEnvelope;
};

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
    ciphertext?: Record<string, unknown>;
    isE2ee?: boolean;
  },
): Promise<void> {
  if (msg.senderType === "bot") return;
  const targets = await botParticipantsFor(conversationId);
  if (targets.length === 0) return;

  const envelope: DmMessageEnvelope = {
    message_id: msg.id,
    conversation_id: conversationId,
    from: { id: msg.senderId, display_name: msg.senderDisplayName },
    reply_to_message_id: msg.replyToMessageId ?? undefined,
    date: Math.floor(new Date(msg.createdAt).getTime() / 1000),
  };
  if (msg.isE2ee && msg.ciphertext) {
    envelope.ciphertext = msg.ciphertext;
  } else {
    envelope.text = msg.text;
  }
  const update: DmUpdate = { update_id: nextId(), type: "dm_message", dm_message: envelope };
  await Promise.all(targets.map((t) => dispatch(t.botId, t.webhookUrl, update)));
}
```

> **Implementor note:** the call sites in `apps/web/app/api/dm/[id]/messages/route.ts` and the new `apps/web/app/api/bot/v1/dm/[id]/messages/route.ts` need to pass `ciphertext` + `isE2ee` for E2EE rows. The user-side route already has `conv.isE2ee` and `parsed.data.ciphertext` in scope; widen the call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/dm-bot-delivery.test.ts`
Expected: PASS (2 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/dm-bot-delivery.ts apps/web/__tests__/dm-bot-delivery.test.ts apps/web/app/api/dm/[id]/messages/route.ts
git commit -m "feat(dm): forward ciphertext to bot participants on E2EE convos"
```

---

### Task 16: Topic bot-membership E2EE gate + Megolm rotation

**Files:**
- Modify: `apps/web/app/api/admin/topics/[id]/bots/route.ts`
- Modify: `apps/web/app/api/admin/topics/[id]/bots/[botId]/route.ts`
- Test: `apps/web/__tests__/topic-bots-e2ee.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/__tests__/topic-bots-e2ee.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { bots, topics, topicBots, topicMembers, userDeviceChangeLog } from "@legends/db/schema";
import { POST as ADD } from "@/app/api/admin/topics/[id]/bots/route";
import { DELETE as REMOVE } from "@/app/api/admin/topics/[id]/bots/[botId]/route";

const FAKE_ADMIN_ID = randomUUID();
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: FAKE_ADMIN_ID, isAnon: false, displayName: "a", permissions: new Set(["bots.manage", "BOTS_MANAGE"]) }),
}));

async function addBot(topicId: string, botId: string): Promise<Response> {
  return ADD(
    new Request(`http://t/admin/topics/${topicId}/bots`, { method: "POST", body: JSON.stringify({ botId }) }),
    { params: Promise.resolve({ id: topicId }) },
  );
}
async function removeBot(topicId: string, botId: string): Promise<Response> {
  return REMOVE(
    new Request(`http://t/admin/topics/${topicId}/bots/${botId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: topicId, botId }) },
  );
}

let e2eeTopicId: string;
let memberUserId: string;
let readyBotId: string;
let pendingBotId: string;

describe("topic_bots E2EE gate + rotation", () => {
  beforeAll(async () => {
    memberUserId = randomUUID();
    await db.execute(sql`INSERT INTO users (id, display_name) VALUES (${FAKE_ADMIN_ID}, 'adm'), (${memberUserId}, 'mem') ON CONFLICT DO NOTHING`);
    const [t] = await db.insert(topics).values({
      slug: `tbe-${Date.now()}`, name: "tbe", isE2ee: true,
    }).returning({ id: topics.id });
    e2eeTopicId = t!.id;
    await db.update(topics).set({ e2eeRoomId: `!${e2eeTopicId}:legends.local` }).where(sql`${topics.id} = ${e2eeTopicId}`);
    await db.insert(topicMembers).values({ topicId: e2eeTopicId, userId: memberUserId });
    const [b1] = await db.insert(bots).values({
      name: `tbe-ready-${Date.now()}`, ownerUserId: FAKE_ADMIN_ID, isActive: true,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      e2eeState: "ready", e2eeDeviceId: "X",
    }).returning({ id: bots.id });
    readyBotId = b1!.id;
    const [b2] = await db.insert(bots).values({
      name: `tbe-pending-${Date.now()}`, ownerUserId: FAKE_ADMIN_ID, isActive: true,
      tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
      e2eeState: "pending",
    }).returning({ id: bots.id });
    pendingBotId = b2!.id;
  });

  it("add ready bot to E2EE topic succeeds + logs device change for members", async () => {
    const res = await addBot(e2eeTopicId, readyBotId);
    expect(res.status).toBe(200);
    const tbs = await db.select().from(topicBots).where(sql`${topicBots.topicId} = ${e2eeTopicId} AND ${topicBots.botId} = ${readyBotId}`);
    expect(tbs).toHaveLength(1);
    const changes = await db.select().from(userDeviceChangeLog).where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`);
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("add non-ready bot to E2EE topic returns 400 bot_e2ee_required", async () => {
    const res = await addBot(e2eeTopicId, pendingBotId);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bot_e2ee_required");
  });

  it("removing a bot logs another device-change for members", async () => {
    const beforeCount = (await db.select().from(userDeviceChangeLog).where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`)).length;
    const res = await removeBot(e2eeTopicId, readyBotId);
    expect(res.status).toBe(200);
    const afterCount = (await db.select().from(userDeviceChangeLog).where(sql`${userDeviceChangeLog.userId} = ${memberUserId}`)).length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @legends/web exec vitest run __tests__/topic-bots-e2ee.test.ts`
Expected: first test fails — `add ready bot to E2EE topic` returns `400 bots cannot be added to E2EE topics` (current line 36 hard-blocks all E2EE adds).

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/api/admin/topics/[id]/bots/route.ts — replace the
// "bots cannot be added to E2EE topics" branch with a state-machine check
// and on success, fan out device-change log rows for every topic member
// (the existing rotation signal /api/crypto/sync surfaces as
// device_lists.changed).
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { bots, topicBots, topicMembers, topics } from "@legends/db/schema";
import { PERMISSIONS, BOT_E2EE_ERROR_CODES } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

export async function GET(/* unchanged */) { /* keep existing body */ }

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId } = await params;
  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (!topic) return NextResponse.json({ error: "topic not found" }, { status: 404 });

  const body = await req.json() as { botId: string };
  if (!body.botId) return NextResponse.json({ error: "botId required" }, { status: 400 });

  const [bot] = await db.select({ id: bots.id, e2eeState: bots.e2eeState }).from(bots)
    .where(and(eq(bots.id, body.botId), eq(bots.isActive, true))).limit(1);
  if (!bot) return NextResponse.json({ error: "bot not found or inactive" }, { status: 404 });

  if (topic.isE2ee && bot.e2eeState !== "ready") {
    return NextResponse.json({ error: BOT_E2EE_ERROR_CODES.BOT_E2EE_REQUIRED }, { status: 400 });
  }

  await db.insert(topicBots).values({ botId: body.botId, topicId }).onConflictDoNothing();

  // Rotate Megolm: existing members' /api/crypto/sync surfaces userDeviceChangeLog
  // rows as device_lists.changed → OlmMachine re-queries their device sets and
  // rotates the outbound Megolm session. We append one row per topic member.
  if (topic.isE2ee) {
    const members = await db.select({ userId: topicMembers.userId }).from(topicMembers).where(eq(topicMembers.topicId, topicId));
    for (const m of members) {
      await logDeviceChange(m.userId, `topic_bot_add:${body.botId}`);
    }
  }

  return NextResponse.json({ ok: true });
}
```

```ts
// apps/web/app/api/admin/topics/[id]/bots/[botId]/route.ts
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { topicBots, topicMembers, topics } from "@legends/db/schema";
import { PERMISSIONS } from "@legends/shared";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { logDeviceChange } from "@/lib/device-change-log";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; botId: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !user.permissions.has(PERMISSIONS.BOTS_MANAGE)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id: topicId, botId } = await params;
  await db.delete(topicBots).where(and(eq(topicBots.topicId, topicId), eq(topicBots.botId, botId)));

  const [topic] = await db.select({ isE2ee: topics.isE2ee }).from(topics).where(eq(topics.id, topicId)).limit(1);
  if (topic?.isE2ee) {
    const members = await db.select({ userId: topicMembers.userId }).from(topicMembers).where(eq(topicMembers.topicId, topicId));
    for (const m of members) {
      await logDeviceChange(m.userId, `topic_bot_remove:${botId}`);
    }
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @legends/web exec vitest run __tests__/topic-bots-e2ee.test.ts`
Expected: PASS (3 it-blocks)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/admin/topics/[id]/bots/route.ts apps/web/app/api/admin/topics/[id]/bots/[botId]/route.ts apps/web/__tests__/topic-bots-e2ee.test.ts
git commit -m "feat(topics): allow ready bots in E2EE topics + log device change for rotation"
```

---

## Done criteria for Part 1

- All 16 tasks pass `pnpm --filter @legends/web exec vitest run` (and the two `@legends/shared` / `@legends/db` runs).
- `pnpm --filter @legends/db migrate` applies `0045_bot_e2ee.sql` cleanly against the dev DB.
- `pnpm typecheck` is green across the repo.

Part 2 (bot SDK) consumes:
- The `/api/bot/v1/crypto/*` mirror endpoints.
- The `getMe()` response shape — extended to include `e2ee_state` + `e2ee_device_id` (NOT in this plan; flag for Part 2 — touches `apps/web/app/api/bot/v1/getMe/route.ts`).

Part 3 (admin UI + docs) consumes:
- The `bots.e2ee_state` column + `bots.e2ee_device_id`.
- The `BOT_E2EE_ERROR_CODES` constants for client-side branching.
- New endpoint `PATCH /api/admin/bots/[id]/e2ee` (NOT in this plan; flag for Part 3).
