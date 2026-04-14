# Legends Chat

Community PWA chat. See [the architecture plan](/root/.claude/plans/recursive-mapping-prism.md) (or the equivalent in this repo's docs once copied over) for the full design.

## Stack

- Next.js 15 (App Router) PWA — `apps/web`
- Socket.IO + Redis adapter — `apps/ws`
- grammY Telegram bot — `apps/bot`
- Postgres + Drizzle ORM — `packages/db`
- Shared zod / permissions / events — `packages/shared`
- XChaCha20-Poly1305 at-rest encryption — `packages/crypto`

## First-time setup

```bash
cp .env.example .env
# generate strong secrets:
#   openssl rand -base64 32   -> ENCRYPTION_MASTER_KEY
#   openssl rand -hex 32      -> JWT_ACCESS_SECRET
#   openssl rand -hex 32      -> JWT_REFRESH_SECRET
# create a Telegram bot via @BotFather and put the token in TELEGRAM_BOT_TOKEN

pnpm install
docker compose up -d              # postgres + redis
pnpm db:generate                  # generate initial migration from schema
pnpm db:migrate                   # apply migrations
pnpm db:seed                      # admin user, topics, encryption key, invite code
```

## Run

```bash
pnpm dev   # starts web (3000), ws (3001), bot in parallel
```

Open Telegram, DM your bot, send `/start`, send the seeded invite code `WELCOME-SEED` (or generate fresh ones from `/admin`), tap the login link.

## Layout

```
apps/
  web/   Next.js PWA, auth callback, topic UI, admin endpoints
  ws/    Socket.IO server (cookie-auth via JWT, redis pubsub for ban/mute)
  bot/   grammY bot: /start, registration, login link issuance
packages/
  db/      Drizzle schema, migrations, seed
  shared/  zod, permission keys, event names, JWT payload schemas
  crypto/  encryption-at-rest helpers
```

## Slice 1 status — complete

- Telegram bot login flow (invite-only by default, public toggle in `registration_config`)
- JWT auth (access + refresh cookies, jti revocation set in Redis)
- Topic list (sticky-first, unread badges, last-message preview)
- Topic view over Socket.IO with at-rest XChaCha20-Poly1305 encryption
- Reactions: quick picker, persisted, live-broadcast add/remove chips
- Message reporting → moderation queue with dismiss / delete / mute / ban
- Ban + mute with session revocation and pubsub-driven socket disconnect
- Auto-delete worker: age mode (60s tick) and count mode (per-insert trim)
- Web Push: VAPID subscribe, service worker, server-side delivery on new messages
- Bot Telegram-side ban check with time-remaining message
- Admin endpoints for topics, invites, bans, mutes, and moderation actions
- PWA manifest + service worker registration (icons still need to be dropped in `public/`)

## Out of scope for slice 1

- Internal bot API (slice 2)
- E2EE per topic (deferred; data model and at-rest layer already shaped for it)
- Reply threading UI, message edit, attachment uploads

