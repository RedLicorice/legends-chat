# Changelog — 2026-06-12

## Bot end-to-end encryption (DMs + channels)

Bots become first-class E2EE principals. A bot now runs its own
`matrix-sdk-crypto-wasm` (vodozemac) Olm machine, uploads device + one-time
keys, and can decrypt/encrypt Megolm envelopes — so an admin can turn on E2EE
for a DM with a bot or a channel that a bot sits in, and the bot participates
in the ratchet like any other member. Built on the shared crypto stack from
the 06-11 E2EE work.

### Data model + principals
- Migration `0045`: bot E2EE state machine (`bots.e2ee_state` = `disabled` |
  `pending` | `ready`, `bots.e2ee_device_id`) + `bot_devices`,
  `bot_one_time_keys`, `bot_to_device_queue` tables (Matrix-shaped, mirroring
  the user crypto tables).
- `crypto-principal` dispatch layer routes every crypto op by principal type
  (user vs bot); bot matrix-id namespace helpers + `parseMatrixPrincipal`.
- `BOT_E2EE_ERROR_CODES` constants (`@legends/shared`) for gating.

### Server crypto endpoints (principal-aware)
- `/api/crypto/keys/query` dispatches by principal type; `/api/crypto/sendToDevice`
  routes bot recipients into `bot_to_device_queue`.
- `/api/bot/v1/crypto/keys/upload` — bot device + OTK upload; transitions
  `pending → ready`.
- `/api/bot/v1/crypto/keys/query` — device lists for user + bot principals.
- `/api/bot/v1/crypto/keys/claim` — claim user + bot OTKs atomically.
- `/api/bot/v1/crypto/sendToDevice` — PUT with body-hash idempotency.
- `/api/bot/v1/crypto/sync` — drains `bot_to_device_queue` for the bot.
- `/api/bot/v1/crypto/rooms/[roomId]` — returns members + devices for room-key
  sharing.

### Bot SDK
- `BotOlmMachine` wrapper around `matrix-sdk-crypto-wasm`; `OlmStore`
  FS-persisted pickle blob; `BotCryptoTransport` HTTP client.
- `OlmMachine` initialized on start when `e2ee_state` is set.
- Background `_cryptoSyncLoop` drains to-device with backoff; tops up OTKs when
  the server count drops.
- Decrypts incoming E2EE DM + topic envelopes; encrypts outgoing replies and
  shares Megolm room keys.

### Wiring + admin
- DM open path gains a bot-E2EE state-machine gate; ciphertext forwarded to bot
  participants on E2EE conversations; `sendMessage` emits ciphertext,
  `sendDmMessage` RPC added.
- E2EE topics accept `ready` bots; device changes logged for key rotation.
- Admin: `PATCH /api/admin/bots/[id]/e2ee` drives the state machine;
  `AdminBotsE2eeSection` component mounts an E2EE panel per bot row; page-data
  returns E2EE fields. Sample `jane` bot ships E2EE-enabled.

### Follow-up fixes (same day)
- `chatCrypto.init` called per instance — `ChatPane`/`DmRightPane` no longer
  gate on a shared `e2eeReady`; init runs on a fresh crypto client.
- `ensureDmSession` ordering: pump after `updateTrackedUsers`, share room key
  before `encryptRoomEvent`, drain requests scheduled by concurrent callers.
- Bot SDK IDB snapshot/restore captures schema (keyPath + indices) and opens
  the current version — fixes stale-version `NotFoundError` for the matrix wasm
  store.
- Sync route emits the bot matrix id when a to-device sender is a bot.
- Whitepaper re-tensed: bot E2EE shipped.
