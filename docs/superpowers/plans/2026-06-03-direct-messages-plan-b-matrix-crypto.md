# Direct Messages — Plan B': E2EE via matrix-sdk-crypto-wasm (Double Ratchet + Megolm)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit ONLY at the end, in a single squash-style commit after Phase B' tasks 2–7 are green.

> **Supersedes** [`2026-05-31-direct-messages-plan-b-double-ratchet.md`](./2026-05-31-direct-messages-plan-b-double-ratchet.md). The previous plan used `@matrix-org/olm` (Emscripten libolm), which has top-level `require("fs")` calls that crash Next 15 Turbopack at build time. All known workarounds (script tag injection, `resolveAlias` stubs, webpack `fs:false` fallbacks) were rejected by the user as hacks. We migrate to `@matrix-org/matrix-sdk-crypto-wasm` v18.3.0 (already in `apps/web/package.json`) — a Rust vodozemac implementation compiled via wasm-bindgen, NCC Group audited, actively maintained by Element / the Matrix Foundation.

**Goal.** Re-enable optional end-to-end encryption for 1:1 DMs in Legends Chat using `matrix-sdk-crypto-wasm`'s `OlmMachine` (Signal Double Ratchet via libolm-compatible sessions). Same library will later cover groups / topics via Megolm (Plan D), so the schema and adapter layer must be built groups-ready from day one.

---

## Context

- Earlier attempt (commit `2cd7df4`) integrated `@matrix-org/olm` 3.2.15 with hand-rolled X3DH-ish prekey bundles. It compiled in dev but blew up Turbopack production builds because libolm's Emscripten glue does `require("fs")` at module load.
- User has rejected all workaround patterns: script-tag injection, `resolveAlias` stubs, `fs: false` webpack fallbacks. Constraint: **no hacks**.
- We are **not** becoming a Matrix server. No federation, no Matrix client compatibility, no Matrix sync API as the primary chat transport. We expose only the minimal subset of Matrix CS-API shapes that `OlmMachine` requires (`/keys/upload`, `/keys/query`, `/keys/claim`, `/sendToDevice`, `/sync`) under our own `/api/crypto/*` namespace. Our existing socket.io + REST chat plane keeps doing the actual message transport; the crypto endpoints carry key material and to-device events only.
- Plan D (groups / topics E2EE) will reuse the same wrapper and endpoints with Megolm sessions. Existing sender-key topic E2EE in `packages/crypto` will be retired; history loss is acceptable.

---

## Architecture

### Library

- `@matrix-org/matrix-sdk-crypto-wasm` v18.3.0 (already installed).
- Single `OlmMachine` per (user, browser device, tab) instance, with an IndexedDB-backed store namespaced `legends-crypto-<userId>`.
- `OlmMachine` is Matrix-shaped — it speaks:
  - Matrix user IDs (`@local:domain`)
  - Matrix device IDs (opaque strings)
  - Matrix room IDs (`!opaque:domain`)
  - `m.room.encrypted` event envelopes
  - `m.olm.v1.curve25519-aes-sha2` Olm to-device wrappers
  - `m.megolm.v1.aes-sha2` for rooms (groups)
  - Standard Matrix sync response shape (`to_device`, `device_lists`, `device_one_time_keys_count`, `device_unused_fallback_key_types`)

### Identity / room adapter

| Legends concept | Matrix shape we present to `OlmMachine` |
| --- | --- |
| `users.id` UUID | `@<userId>:legends.local` |
| Browser session (per user, per device) | random UUID `device_id`, persisted in IndexedDB key `legends-crypto-deviceid-<userId>` |
| DM `conversationId` | `room_id = "!" + conversationId + ":legends.local"` |
| Topic `topicId` (Plan D) | `room_id = "!" + topicId + ":legends.local"` |
| Bot identities | excluded from E2EE (Phase B'). Bots remain plaintext; UI disables encrypted toggle when peer is a bot. |

The adapter functions (`toMxUser`, `fromMxUser`, `toMxRoom(dmId)`, `fromMxRoom`) live in `apps/web/lib/dm-crypto.ts`. They strip / wrap the `:legends.local` suffix and reject malformed values server-side.

### Why one library for DM and groups

- DM = Olm 1:1 Double Ratchet sessions (per-device pairwise ratchets).
- Groups = Megolm sender-key sessions with rotation on membership change / time / message count.
- Both are handled by the same `OlmMachine` instance via `encryptRoomEvent` / `decryptRoomEvent`; the algorithm is selected per-room by `OlmMachine` based on configured room settings.
- One wasm payload, one wrapper, one set of server endpoints. Plan D becomes "open more rooms, change membership delta source," not "ship a new crypto stack."

### What we do NOT build

- No Matrix federation.
- No Matrix CS-API surface beyond the five endpoints listed below.
- No cross-signing UX (skipped v1; TOFU + safety numbers only).
- No SSSS / server-side key backup (skipped v1; lose device = lose history; documented in setup UI).
- No Element/third-party client compatibility — adapter prefix `legends.local` is internal-only and never federated.

---

## Phase B' — DM rewrite (scope of this plan)

### B'.1 Schema migration `0038_dm_matrix_crypto.sql`

Path: `packages/db/src/migrations/0038_dm_matrix_crypto.sql` and corresponding edits to `packages/db/src/schema.ts`.

**Wipe rule.** Dev DBs may have existing `user_key_bundles` / `user_one_time_prekeys` rows from migration `0037`. No prod data exists. Migration does `DELETE FROM user_one_time_prekeys; DELETE FROM user_key_bundles;` before structural changes.

#### `user_key_bundles` — restructure for Matrix device keys

- Drop columns added in `0037`: `signed_prekey_id`, `signed_prekey`, `signed_prekey_sig`, `signed_prekey_updated_at` (OlmMachine manages its own signed prekey internally; we only ever transport the device-key block and one-time keys).
- Add columns:
  - `device_id text NOT NULL`
  - `algorithms_json jsonb NOT NULL` — e.g. `["m.olm.v1.curve25519-aes-sha2","m.megolm.v1.aes-sha2"]`
  - `keys_json jsonb NOT NULL` — e.g. `{ "curve25519:<deviceId>": "<base64>", "ed25519:<deviceId>": "<base64>" }`
  - `signatures_json jsonb NOT NULL` — e.g. `{ "@user:legends.local": { "ed25519:<deviceId>": "<sig>" } }`
  - `fallback_key_json jsonb NULL` — single fallback key block (rotated by OlmMachine), nullable
- Keep `olm_identity_curve25519 text` and `olm_identity_ed25519 text` as denormalized lookups, populated by trigger or by the upload route extracting them from `keys_json` — used for quick fingerprint render and legacy callers during transition.
- Replace primary key: `PRIMARY KEY (user_id, device_id)`. Foreign key on `user_id` → `users(id) ON DELETE CASCADE` stays.

#### `user_one_time_prekeys` — restructure for Matrix one-time keys

- Add `device_id text NOT NULL`.
- Change `key_id text` semantics: now a Matrix-style algorithm-prefixed ID, e.g. `signed_curve25519:AAAAAQ`. Drop any uniqueness constraint that assumed bare integer IDs.
- Replace `key text NOT NULL` with `key_json jsonb NOT NULL` (a Matrix one-time-key block, including signatures).
- Replace primary key: `PRIMARY KEY (user_id, device_id, key_id)`.
- Index: `CREATE INDEX user_one_time_prekeys_claim_idx ON user_one_time_prekeys (user_id, device_id);` for the SKIP LOCKED pop.
- Foreign key on `(user_id, device_id)` → `user_key_bundles(user_id, device_id) ON DELETE CASCADE`.

#### `user_to_device_queue` — new table

```sql
CREATE TABLE user_to_device_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_id text NOT NULL,   -- exact device_id, or '*' for broadcast
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_device_id text NOT NULL,
  event_type text NOT NULL,            -- e.g. 'm.room.key', 'm.olm.v1.curve25519-aes-sha2'
  content_json jsonb NOT NULL,
  txn_id text NOT NULL,                -- idempotency from sendToDevice client txnId
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_to_device_queue_recipient_idx
  ON user_to_device_queue (recipient_user_id, recipient_device_id, created_at);

CREATE UNIQUE INDEX user_to_device_queue_txn_idx
  ON user_to_device_queue (sender_user_id, txn_id);
```

Retention: rows older than 30 days OR consumed by all known recipient devices are pruned by a periodic job (out of scope; document only).

#### `dm_conversations` — add room ID

- Add `e2ee_room_id text NULL UNIQUE`.
- Populated only when conversation is opened with `{ e2ee: true }`. Value: `'!' || dm_conversations.id::text || ':legends.local'`.

#### `dm_messages` — add ciphertext envelope

- Add `ciphertext_json jsonb NULL`.
- When `dm_conversations.e2ee_room_id IS NOT NULL`, sender path stores the full `m.room.encrypted` envelope here and leaves `text` NULL.
- App CHECK (advisory, can be enforced later): exactly one of `text` / `ciphertext_json` is non-null per row.

#### Drizzle schema updates

Edit `packages/db/src/schema.ts` accordingly. Export the new table `userToDeviceQueue`. Re-export adjusted column types. Run `pnpm db:generate` is **NOT** required because migration is hand-written under `migrations/`; instead make sure `schema.ts` matches the post-migration shape so the type checker doesn't drift.

### B'.2 Crypto wrapper `apps/web/lib/dm-crypto.ts`

Replaces and deletes `apps/web/lib/dm-olm.ts`. All access to `@matrix-org/matrix-sdk-crypto-wasm` is via **dynamic `await import(...)`** at call time so the 3 MB wasm bundle is never in the first-load JS for non-E2EE users.

Public API:

```ts
// apps/web/lib/dm-crypto.ts
export type CryptoEnvelope = Record<string, unknown>; // m.room.encrypted JSON

export async function init(userId: string, accessToken: string): Promise<void>;
//   - Loads wasm via dynamic import.
//   - Derives stable deviceId: read IndexedDB key `legends-crypto-deviceid-<userId>`;
//     if missing, generate crypto.randomUUID() and persist.
//   - Instantiates: OlmMachine.initialize(
//       new UserId(`@${userId}:legends.local`),
//       new DeviceId(deviceId),
//       /* storeName */ `legends-crypto-${userId}`,
//       /* passphrase */ undefined            // v1: unencrypted IndexedDB store
//     )
//   - Stores accessToken on a module-local so pumpOutgoing() can attach Authorization.

export async function bootstrap(): Promise<void>;
//   - Calls pumpOutgoing() once to drain initial KeysUpload / KeysQuery /
//     SignatureUpload requests so the server has our device + OTKs registered
//     before the first encrypt attempt.

export async function encryptDm(
  roomId: string,
  plaintext: string
): Promise<CryptoEnvelope>;
//   - Resolves peer userId from roomId via caller-supplied lookup (passed at init,
//     or via setRoomPeerResolver(fn)) — actually: roomId-to-peer is derived from
//     dm_conversations.e2ee_room_id ↔ id mapping; caller passes peerUserId(s) in
//     a separate ensurePeers() call before encryptDm. See flow below.
//   - Calls olm.updateTrackedUsers([peer]) if not yet tracked.
//   - Calls olm.getMissingSessions([peer]); if any, pumpOutgoing() to run /keys/claim.
//   - Calls olm.shareRoomKey(roomId, [peer], encryptionSettings) — for DM rooms
//     encryptionSettings = { algorithm: m.olm.v1.curve25519-aes-sha2 } (no Megolm).
//   - pumpOutgoing() to deliver any new to-device m.room.key events.
//   - Returns await olm.encryptRoomEvent(roomId, 'm.room.message',
//     JSON.stringify({ msgtype:'m.text', body: plaintext })) parsed as JSON.

export async function ensurePeers(roomId: string, peers: string[]): Promise<void>;
//   - Helper that does the tracked-users + missing-sessions + pumpOutgoing dance
//     up-front (called when opening a conversation), so encryptDm becomes a
//     pure local op when a session already exists.

export async function decryptDm(
  roomId: string,
  envelope: CryptoEnvelope,
  senderUserId: string,
  senderDeviceId: string
): Promise<string>;
//   - Wraps envelope in a synthetic Matrix room event: { type:'m.room.encrypted',
//     sender:`@${senderUserId}:legends.local`, content: envelope, event_id, origin_server_ts, room_id }.
//   - Calls olm.decryptRoomEvent(syntheticEvent, roomId).
//   - Parses returned cleartext JSON (m.room.message body) and returns body string.

export async function pumpOutgoing(): Promise<void>;
//   - Loop: const reqs = await olm.outgoingRequests();
//     for each req, dispatch to the matching /api/crypto/* endpoint
//     (KeysUpload→keys/upload, KeysQuery→keys/query, KeysClaim→keys/claim,
//      ToDevice→sendToDevice, SignatureUpload→keys/signatures/upload — we
//      noop SignatureUpload server-side since no cross-signing).
//     await olm.markRequestAsSent(req.id, req.type, JSON.stringify(serverResponse)).

export async function feedSync(sync: {
  next_batch: string;
  to_device: { events: unknown[] };
  device_lists: { changed: string[]; left: string[] };
  device_one_time_keys_count: Record<string, number>;
  device_unused_fallback_key_types: string[];
}): Promise<void>;
//   - Maps device_lists.changed/left from @user:legends.local → bare userId.
//   - Calls olm.receiveSyncChanges(
//       JSON.stringify(sync.to_device),
//       new DeviceLists(changed, left),
//       new Map(Object.entries(sync.device_one_time_keys_count)),
//       sync.device_unused_fallback_key_types
//     ).
//   - Persists sync.next_batch in localStorage key `legends-crypto-sync-<userId>`.

export async function getMyFingerprint(): Promise<string>;
//   - Returns olm.identityKeys().ed25519 formatted as 12 groups of 4 base32 chars
//     (safety-number style).

export async function getPeerFingerprint(
  userId: string,
  deviceId: string
): Promise<string | null>;
//   - Reads peer device from olm.getDevice(new UserId(...), new DeviceId(...));
//     returns ed25519 formatted the same way.

export async function freeResources(): Promise<void>;
//   - Calls olm.free() and clears module-locals; called from React effect cleanup
//     on full sign-out (not on per-render unmount).
```

Persistence: rely entirely on `OlmMachine`'s built-in IndexedDB store. Wrapper only persists (a) the stable device ID and (b) the sync `next_batch` cursor.

Cold-start cost: dynamic-imported wasm (~3 MB). Mitigations in "Risks" section.

### B'.3 Server crypto endpoints

All under `/api/crypto/*`. Auth: existing session middleware (same as `/api/dm/*`). All routes reject if `session.user.id` does not match the requested user (where applicable). Adapter strips `@…:legends.local` to bare userId; reject if domain mismatch or malformed.

Rate limits (per user, sliding window in Redis, same primitives as existing app):
- `/api/crypto/keys/upload`: 30/min
- `/api/crypto/keys/claim`: 60/min
- Others: 120/min

#### `POST /api/crypto/keys/upload`

Request:
```json
{
  "device_keys": {
    "user_id": "@<userId>:legends.local",
    "device_id": "<deviceId>",
    "algorithms": ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    "keys": { "curve25519:<deviceId>": "...", "ed25519:<deviceId>": "..." },
    "signatures": { "@<userId>:legends.local": { "ed25519:<deviceId>": "..." } }
  },
  "one_time_keys": {
    "signed_curve25519:AAAA": { "key": "...", "signatures": { ... } },
    "signed_curve25519:AAAB": { "key": "...", "signatures": { ... } }
  },
  "fallback_keys": {
    "signed_curve25519:FB1": { "key": "...", "fallback": true, "signatures": { ... } }
  }
}
```
All three top-level keys are optional (a request can be device-keys-only, OTKs-only, fallback-only).

Server:
1. Verify `device_keys.user_id` and `device_keys.device_id` (if `device_keys` present) match the authenticated session user and the upload's claimed device ID. Reject 400 on mismatch.
2. Upsert `user_key_bundles` row by `(userId, deviceId)`, setting `algorithms_json`, `keys_json`, `signatures_json`, and denormalized `olm_identity_curve25519` / `olm_identity_ed25519` extracted from `keys_json`.
3. If `fallback_keys` present, overwrite `fallback_key_json` (single key — last-write-wins).
4. If `one_time_keys` present, batch-insert into `user_one_time_prekeys` (`ON CONFLICT (user_id, device_id, key_id) DO NOTHING` so retries are idempotent).
5. Compute `count = SELECT COUNT(*) FROM user_one_time_prekeys WHERE user_id=$1 AND device_id=$2 AND key_id LIKE 'signed_curve25519:%'`.

Response:
```json
{ "one_time_key_counts": { "signed_curve25519": 47 } }
```

#### `POST /api/crypto/keys/query`

Request:
```json
{
  "device_keys": {
    "@<userIdA>:legends.local": [],
    "@<userIdB>:legends.local": ["<specificDeviceId>"]
  },
  "timeout": 10000
}
```
(`[]` means "all devices for this user".)

Server:
1. Strip suffix on each user ID; validate.
2. For each user: select `user_key_bundles` rows; if device list non-empty, filter.
3. Reconstruct each device's block from stored columns.

Response:
```json
{
  "device_keys": {
    "@<userIdA>:legends.local": {
      "<deviceIdA1>": { "user_id":"@<userIdA>:legends.local", "device_id":"<deviceIdA1>", "algorithms":[...], "keys":{...}, "signatures":{...} }
    }
  },
  "master_keys": {},
  "self_signing_keys": {},
  "user_signing_keys": {},
  "failures": {}
}
```
Cross-signing key sections are returned empty (we don't implement cross-signing v1).

#### `POST /api/crypto/keys/claim`

Request:
```json
{
  "one_time_keys": {
    "@<userId>:legends.local": { "<deviceId>": "signed_curve25519" },
    "...": { "...": "signed_curve25519" }
  },
  "timeout": 10000
}
```

Server: for each `(userId, deviceId)`, atomically pop one OTK row:

```sql
DELETE FROM user_one_time_prekeys
WHERE ctid IN (
  SELECT ctid FROM user_one_time_prekeys
  WHERE user_id = $1 AND device_id = $2 AND key_id LIKE 'signed_curve25519:%'
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING key_id, key_json;
```

If no OTK available: fall back to the device's `fallback_key_json` from `user_key_bundles` (do not delete; fallback is reusable until rotated).

If neither OTK nor fallback available: include the device under `failures`.

Response:
```json
{
  "one_time_keys": {
    "@<userId>:legends.local": {
      "<deviceId>": { "signed_curve25519:AAAA": { "key":"...", "signatures":{...} } }
    }
  },
  "failures": {}
}
```

After successful claim, server SHOULD enqueue a hint (out of scope for v1 — client will replenish on next `outgoingRequests()` cycle when `device_one_time_keys_count` from `/sync` drops below threshold).

#### `PUT /api/crypto/sendToDevice/:eventType/:txnId`

Path params:
- `eventType` — URL-encoded Matrix event type (`m.room.key`, `m.olm.v1.curve25519-aes-sha2`, etc.). Validated against an allowlist: `m.room.key`, `m.room.key.request`, `m.forwarded_room_key`, `m.key.verification.*`, `m.olm.v1.curve25519-aes-sha2`, `m.room_key_withheld`. Reject 400 otherwise.
- `txnId` — client-chosen idempotency key.

Request:
```json
{
  "messages": {
    "@<userId>:legends.local": {
      "<deviceIdOrStar>": { /* opaque content */ }
    }
  }
}
```

Server:
1. For each `(userId, deviceId|'*')`, insert one row into `user_to_device_queue` with `sender_user_id = session.userId`, `sender_device_id = req header X-Legends-Device-Id` (set by wrapper), `txn_id = path :txnId`, `event_type`, `content_json`.
2. `ON CONFLICT (sender_user_id, txn_id) DO NOTHING` so retries are idempotent.
3. After insert, emit a socket.io push on `to_device:<recipientUserId>` channel (best-effort wakeup — clients still must call `/sync` for ordering).

Response: `{}`.

#### `GET /api/crypto/sync?since=<cursor>&timeout=<ms>`

Server:
1. Parse `since` as a queue row id watermark (or empty for "from start"). `timeout` ignored in v1 (no long-poll); client polls every 5 s.
2. Determine recipient devices: all devices owned by `session.userId` (rows from `user_key_bundles WHERE user_id = session.userId`). We don't know which tab is calling; client supplies its `deviceId` via `X-Legends-Device-Id` header so we filter to that device + `*`.
3. Select up to N=200 rows from `user_to_device_queue` where:
   - `recipient_user_id = session.userId`
   - `recipient_device_id IN (<header device>, '*')`
   - `id > since` (lexicographic on uuid v7 sort, or use `created_at` tiebreak — choose a stable comparable cursor; spec: use a separate `seq bigserial` column added in 0038 to make watermarking trivial).
4. Compute fresh `device_one_time_keys_count` for that device (same query as upload returns).
5. Determine `device_lists.changed`: users whose any device row was inserted/updated since `since`'s timestamp (looked up from row id → ts via the queue or a parallel `user_device_change_log` table). v1 simplification: return empty `changed` and `left` — clients re-query when needed via `ensurePeers`. Document this gap; revisit in Phase D.

> **Schema addendum to 0038:** add `seq bigserial NOT NULL UNIQUE` to `user_to_device_queue` to give a monotonically-increasing watermark independent of uuid ordering.

Response:
```json
{
  "next_batch": "<lastSeq>",
  "to_device": {
    "events": [
      { "type": "m.room.key", "sender": "@<userId>:legends.local", "content": { ... } }
    ]
  },
  "device_lists": { "changed": [], "left": [] },
  "device_one_time_keys_count": { "signed_curve25519": 47 },
  "device_unused_fallback_key_types": []
}
```

### B'.4 DM open / send / receive flow

#### Opening a conversation

`apps/web/lib/dm.ts::openConversation(initiator, peer, { e2ee: true })`:
- Server route `POST /api/dm` (`openSchema` already has `e2ee` field):
  - If `e2ee === true` and peer is not a bot: insert / fetch DM row and `UPDATE dm_conversations SET e2ee_room_id = '!' || id::text || ':legends.local' WHERE id = $1 AND e2ee_room_id IS NULL`.
  - If peer is a bot and `e2ee === true`: 400 reject.

#### Sending an E2EE DM (client)

In `DmClient.tsx` send handler, when `conversation.e2ee_room_id` is set:

1. Lazy-load wrapper: `const crypto = await import('@/lib/dm-crypto')`.
2. `await crypto.init(currentUserId, accessToken)` (idempotent — cached after first call per page lifetime).
3. `await crypto.ensurePeers(roomId, [peerUserId])` (no-op on warm path).
4. `const envelope = await crypto.encryptDm(roomId, plaintextInput)`.
5. `POST /api/dm/[id]/messages` with body `{ ciphertext_json: envelope }`.
   - Existing route accepts E2EE messages already; extend body schema to take either `text: string` OR `ciphertext_json: object`, mutually exclusive.
   - Server stores `ciphertext_json` in `dm_messages.ciphertext_json`, leaves `text` NULL.
   - Socket.io broadcast `dm:message:new` carries the full row (including `ciphertext_json`).

#### Receiving an E2EE DM (client)

1. Background poll loop in `DmClient.tsx`: every 5 s while tab is visible, plus on focus, plus on socket.io push `to_device:<myUserId>` — call `GET /api/crypto/sync?since=<cursor>&deviceId=<X-Legends-Device-Id>` and `await crypto.feedSync(resp)`. Persist `resp.next_batch`.
2. When a `dm:message:new` socket event arrives with `ciphertext_json`:
   - `await crypto.feedSync(...)` at least once first (so the corresponding `m.room.key` to-device event has been ingested).
   - `await crypto.decryptDm(roomId, ciphertext_json, senderUserId, senderDeviceId)` → plaintext.
   - If `decryptRoomEvent` throws "missing session" → trigger an extra `/sync` poll then retry once; if still failing, show "🔒 unable to decrypt" placeholder with a retry button.
3. Render plaintext alongside non-E2EE messages. 🔒 indicator stays per-message.

### B'.5 DmClient wiring (`apps/web/components/DmClient.tsx`)

Most scaffolding already exists from commit `2cd7df4`. Changes:

- Replace `import("@/lib/dm-olm")` references with `import("@/lib/dm-crypto")`.
- Setup gate: detect "no device keys uploaded" via `/api/crypto/keys/query` for own user — if zero devices, render "Initialize encryption on this device" CTA. On click: `await crypto.init(); await crypto.bootstrap();` then refresh.
- Encrypted-toggle: only show when peer is `user` (not `bot`); already wired but verify after refactor.
- 🔒 indicator: per-message badge when `ciphertext_json` is non-null.
- Safety-number modal: shows `getMyFingerprint()` and `getPeerFingerprint(peerUserId, peerDeviceId)`. Multi-device peers: pick first device for v1, document "verify each device separately" as a TODO.
- Sync loop: `useEffect` with `setInterval(5000)` + `document.visibilitychange` + `socket.on('to_device:'+userId, …)` triggering `runSync()`. `runSync()` debounced to at most 1 in flight.
- Mobile responsive single-pane (already done in commit `3aa7d33`) — verify no regression.
- Cleanup: `crypto.freeResources()` on full unmount of the DM root only (not on conversation switch), because re-init is expensive.

### B'.6 Cleanup

- Delete `apps/web/lib/dm-olm.ts`.
- Delete `apps/web/app/api/user/keys/prekeys/route.ts`.
- Delete `apps/web/app/api/user/keys/bundle/route.ts`.
- Confirm `@matrix-org/olm` is **not** in `apps/web/package.json` (the wasm migration commit `2cd7df4` may still have it; remove if present and `pnpm install`).
- Drop `signedPrekey*` columns and corresponding `schema.ts` fields added in migration `0037` (handled inside `0038_dm_matrix_crypto.sql`).
- Mark `docs/superpowers/plans/2026-05-31-direct-messages-plan-b-double-ratchet.md` superseded with banner:
  > `> **SUPERSEDED** by [`2026-06-03-direct-messages-plan-b-matrix-crypto.md`](./2026-06-03-direct-messages-plan-b-matrix-crypto.md) — Olm package bundler-hostile in Next 15 Turbopack; switched to matrix-sdk-crypto-wasm.`

---

## Phase D (sketch only — out of scope for this plan's implementation)

- Topics = Matrix rooms. `e2ee_room_id` on `topics` table, same `!<id>:legends.local` shape.
- Existing sender-key E2EE topics: wiped on migration; members re-opt-in. History loss accepted (already documented).
- Remove sender-key code in `packages/crypto` (or keep behind a build flag for one release for forensic decryption of archives).
- Membership delta source: when a user is added/removed from a topic, server pushes a synthetic `device_lists.changed` entry on next `/sync` so `OlmMachine` triggers `/keys/query` + Megolm key rotation.
- New endpoint `GET /api/crypto/rooms/:roomId/members` → `{ joined: ["@<userId>:legends.local", ...] }` so `OlmMachine` can call `shareRoomKey(roomId, members, { algorithm: 'm.megolm.v1.aes-sha2', rotationPeriodMs, rotationPeriodMsgs })`.
- Send / receive path is unchanged: `encryptDm` / `decryptDm` work for Megolm too (the wrapper name should be renamed `encryptRoom` / `decryptRoom` in Phase D — note for future PR).

---

## Risks and open questions

- **3 MB wasm cold load.** Mitigations: HTTP cache headers (immutable, 1y), service-worker precache for signed-in users, lazy dynamic import gated on first E2EE intent. Non-E2EE users never load it.
- **Multi-tab races.** `OlmMachine`'s IndexedDB store is **not** safe under concurrent writers. Options:
  - (A) BroadcastChannel + leader election: only the leader tab owns the `OlmMachine`; other tabs proxy encrypt/decrypt via `postMessage`.
  - (B) Refuse second tab: detect via BroadcastChannel ping; show "E2EE in use in another tab — close it to use here" banner.
  - **Decision required before launch.** Default to (B) for v1 — simpler, no IPC layer.
- **Cross-signing / device verification.** Skipped v1. Only TOFU + safety-number compare on first contact.
- **Server-side key backup.** Skipped v1. Setup gate UI explicitly says "Losing this device means losing E2EE message history. Back up by exporting keys (TODO Phase B''')."
- **Old Safari / wasm-bindgen.** WASM `Module.instantiateStreaming` may fail on Safari <15. Detect via try/catch around `init()`; degrade to "Encrypted DMs are not supported on this browser. Please update to a recent Safari, Chrome, or Firefox."
- **`device_lists.changed` from `/sync`.** v1 returns empty. Means peer device rotation isn't auto-detected — relies on `ensurePeers` on every conversation open. Phase D will add a `user_device_change_log` table.
- **OTK exhaustion.** Wrapper monitors `device_one_time_keys_count` from `/sync`; when below threshold (e.g. 10), `outgoingRequests()` will include a new `KeysUpload`. Server upload route is idempotent so this is fine.
- **Bot peers.** Bots have no `OlmMachine`. UI must hard-disable E2EE toggle when peer kind is `bot`; server must 400 the open request if `e2ee === true && peerKind === 'bot'`.

---

## Test plan

### Unit (vitest, `apps/web/lib/dm-crypto.test.ts`)

- Init two `OlmMachine`s in same test (Alice, Bob), simulate `/keys/upload`, `/keys/query`, `/keys/claim` via in-memory mocks of the dispatch layer.
- Round-trip: Alice `encryptDm` → envelope JSON → Bob `decryptDm` → original plaintext.
- Round-trip in reverse direction in same session (ratchet steps).
- Replay rejection: feeding the same envelope twice to `decryptDm` throws (libolm-level replay guard).

### Integration (`apps/web/__tests__/crypto-endpoints.test.ts`)

- `keys/upload` → `keys/query` round-trip: device block returned matches uploaded.
- `keys/upload` with N OTKs → `keys/claim` N+1 times: last claim falls back to fallback key; (N+2)th claim returns failure.
- `sendToDevice` idempotency: same `txnId` twice inserts only one row.
- `sync` watermark: insert 3 to-device rows, sync from `since=0` returns all 3 and a `next_batch`; sync from that `next_batch` returns 0 rows; insert one more → returns just the new one.

### Live two-user browser (per `reference_dev_browser_testing.md`)

- Bring up full stack with `just dev`.
- Two `auth_login_tokens` issued; two Playwright `isolatedContext`s.
- User A and User B both open the app; A opens an E2EE DM with B (toggle on).
- 3 messages each direction.
- Assertions:
  - In DB: `dm_messages.text IS NULL`, `dm_messages.ciphertext_json IS NOT NULL` for those rows.
  - In UI: plaintext renders correctly on both sides; 🔒 badge present on each message.
  - Safety number: open modal in A's UI, capture; open in B's UI, capture; both report B's ed25519 fingerprint identically and A's identically.
- Refresh A's tab: A reopens convo; prior messages decrypt and render (IndexedDB store survived). New send/receive still works.
- Sign out + sign back in on A: device ID changes, prior history fails to decrypt and renders as "🔒 unable to decrypt" — this is the documented v1 limitation.

### Mobile viewport (375x812)

- Same two-user flow on mobile viewport; single-pane navigation; 🔒 indicator and safety-number modal usable on small screen.

### Negative

- A third user C with a session token tries `GET /api/dm/:id/messages` for A↔B's convo: 403 (already enforced by existing access checks).
- C runs `GET /api/crypto/sync` with their own session: only sees C's own queue; A's and B's `m.room.key` events are not in the response.
- Force-corrupt one byte of `ciphertext_json` server-side: `decryptDm` throws; UI renders "🔒 unable to decrypt" with retry button.

---

## Task list (subagent-driven, single commit at end)

- [ ] **1.** Write this design doc (done — current task) and mark the previous Olm plan as superseded.
- [ ] **2.** Schema migration `0038_dm_matrix_crypto.sql` + `packages/db/src/schema.ts` updates. Apply locally; verify Drizzle compiles.
- [ ] **3.** Server crypto endpoints — five routes under `apps/web/app/api/crypto/*`:
  - [ ] `keys/upload/route.ts`
  - [ ] `keys/query/route.ts`
  - [ ] `keys/claim/route.ts`
  - [ ] `sendToDevice/[eventType]/[txnId]/route.ts`
  - [ ] `sync/route.ts`
- [ ] **4.** Wrapper `apps/web/lib/dm-crypto.ts` (replaces deleted `dm-olm.ts`).
- [ ] **5.** Wire `DmClient.tsx`: lazy import, setup gate, encrypted toggle, 🔒 badge, safety-number modal, sync poll loop, socket.io to-device push handler.
- [ ] **6.** Cleanup: delete `dm-olm.ts`, old `/api/user/keys/{prekeys,bundle}/route.ts`; remove `@matrix-org/olm` from `apps/web/package.json` if still present; run `pnpm install`.
- [ ] **7.** Two-user browser + mobile live test per Test Plan above. Capture screenshots into `.e2e-shots/`.
- [ ] **8.** Single end-of-task commit. Conventional Commits: `feat(dm): rewrite E2EE on matrix-sdk-crypto-wasm (vodozemac) — supersedes Olm Plan B`.

Tasks 2 and 3 can run in parallel after task 1; task 4 depends on 2; task 5 depends on 4; task 6 can run in parallel with task 5; task 7 depends on 5+6.

Parallelization plan (subagent fan-out per `superpowers:dispatching-parallel-agents`):
- Wave A: task 2.
- Wave B: tasks 3 + 4 in parallel after wave A.
- Wave C: tasks 5 + 6 in parallel after wave B.
- Wave D: task 7.
- Wave E: task 8 (commit only after wave D passes).
