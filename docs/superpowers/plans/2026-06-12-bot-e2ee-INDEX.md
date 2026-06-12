# Bot E2EE — Plan Index + Reconciliation

**Spec:** [`docs/superpowers/specs/2026-06-11-bot-e2ee-dms-design.md`](../specs/2026-06-11-bot-e2ee-dms-design.md)

**Total scope:** 29 tasks across 3 plan files. ~6,000 lines of plan markdown.

| Part | Path | Tasks | Phase coverage |
|---|---|---|---|
| 1 | [`2026-06-12-bot-e2ee-part1-backend.md`](./2026-06-12-bot-e2ee-part1-backend.md) | 16 (1–16) | Foundations + server crypto-principal dispatch + `/api/bot/v1/crypto/*` mirror + DM/delivery/topic wiring |
| 2 | [`2026-06-12-bot-e2ee-part2-sdk.md`](./2026-06-12-bot-e2ee-part2-sdk.md) | 8 (17–24) | `@legends/bot-sdk` Olm support |
| 3 | [`2026-06-12-bot-e2ee-part3-admin-docs.md`](./2026-06-12-bot-e2ee-part3-admin-docs.md) | 5 (25–29) | Admin UI + admin API + whitepaper + sample bot |

**Execution order:** Part 1 → Part 2 → Part 3. Part 2 depends on Part 1's `/api/bot/v1/crypto/*` routes for integration tests. Part 3 depends on Part 1's schema + Part 2's SDK presence in the sample bot.

---

## Cross-part reconciliations

Three decisions that emerged during planning, where the plan authors surfaced spec ambiguities. **The decisions below override the spec where they conflict.** Implementing subagents should treat this index as authoritative for these specific items.

### R1 — Bot DM ciphertext route shape: RPC, not REST

- Spec §6 wrote `POST /api/bot/v1/dm/[id]/messages` (REST).
- Existing `/api/bot/v1/*` surface is RPC (`sendMessage`, `editMessage`, `getMe`, etc.). Mixing styles would be jarring and inconsistent with the established SDK pattern.
- **Decision:** rename Part 1 Task 13 route to **`POST /api/bot/v1/sendDmMessage`**. Body: `{conversationId, text? | ciphertext?}`. SDK in Part 2 Task 22 already wraps it as `client.sendDmCiphertext({conversationId, ciphertext})` — matches the existing `client.sendMessage({topicId, text})` shape.
- Part 1 Task 13 — update path + filename accordingly when the implementing subagent executes it.

### R2 — Bot topic ciphertext route

- Spec did not enumerate a separate route for bot E2EE topic sends. Part 2 SDK expects `client.sendTopicCiphertext({topicId, ciphertext})`.
- **Decision:** **extend the existing `POST /api/bot/v1/sendMessage`** route to accept `ciphertext` alongside `text` (per-row CHECK constraint already exists on `messages` table via migration 0041; the route just needs to forward the field). No new route.
- This is a small modification, not a whole task. The Part 1 implementing subagent for Task 13 should also touch `apps/web/app/api/bot/v1/sendMessage/route.ts` (one file, ~15 lines added).
- Task 13's tests should cover both shapes (the original `sendDmMessage` and the `sendMessage` ciphertext branch).

### R3 — Olm state persistence: IDB snapshot via `fake-indexeddb`, not raw pickle

- Spec §3 + §8 described "FS-persisted pickle file" as the storage mechanism. The actual `@matrix-org/matrix-sdk-crypto-wasm` v18.3.0 API does not expose a `pickle()` / `unpickle()` method — the crypto store is IndexedDB-backed only.
- **Decision:** Part 2 Task 17–18 use `fake-indexeddb/auto` (in-memory IDB shim) + a JSON snapshot of the underlying database written atomically to `${BOT_DATA_DIR}/olm-store.json`. The wire-format on disk is a JSON blob, not the Matrix wasm pickle binary.
- This is **opaque to the bot author** — `OlmStore` exposes `load()` / `save()` / `reset()` regardless of the on-disk shape.
- `fake-indexeddb` moves from devDep → runtime dep in `packages/bot-sdk/package.json`.
- Spec language updated retroactively via the whitepaper (Part 3 Task 28) will say "the bot's local Olm store" rather than "pickle file". Internal spec doc stays as-is for historical record.

---

## Known follow-ups (not in this plan)

These came up during planning and are explicitly **deferred**:

1. **Migration 0046 — widen `user_to_device_queue.sender_*` columns** for clean bot-sender support. Part 1 Task 10 currently writes `sender_user_id = bots.ownerUserId` + `sender_device_id = "bot:<botId>"` as a workaround. Functional but ugly. Follow-up should add `sender_principal_type` + drop the NOT NULL on `sender_user_id`.

2. **Topic Megolm rotation signal — synthetic `m.room.member` event** vs. the current `userDeviceChangeLog` fan-out used by Part 1 Task 16. The latter works because the user-side OlmMachine reacts to `device_lists.changed` in `/api/crypto/sync` the same way it would to a member event. Cleaner long-term is to wire up a real member-event emission path; revisit if bot topic membership becomes a hot area.

3. **Multi-replica bot support** via shared/locked Olm store. Single-process only for v1.

4. **Per-message forward secrecy** (Double Ratchet) inside Megolm sessions. Same limitation as user-side E2EE — not addressed in this plan.

5. **Admin UI primitives extraction** — `AdminBotsE2eeSection.tsx` uses inline tailwind for switch/badge/modal because no shared `Switch`/`Modal`/`Badge` primitives exist in the codebase yet. If the admin area grows more form UI, extract these as a follow-up sweep.

6. **`apps/web` vitest bootstrap** — currently part of Part 1 Task 1 + Part 3 Task 25 Step 0 (no-op if Part 1 lands first). If you want cleaner blame, extract bootstrap to a pre-Task-1 step.

---

## Open questions for the user

None. Planning is sealed. Implementation can begin.

If during execution a subagent surfaces a question that *isn't* covered by R1–R3 or the deferred list, it should pause and re-ask the user rather than improvise.

---

## Execution handoff

Recommended approach (per `feedback_execution_mode`): **subagent-driven** via the `superpowers:subagent-driven-development` skill — fresh subagent per task, two-stage review between tasks.

Entry point: Part 1 Task 1.
