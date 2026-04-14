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

## Slice 1 status

What works:
- Telegram bot login flow (invite-only by default, public toggle in `registration_config`)
- JWT auth (access + refresh cookies, jti revocation set in Redis)
- Topic list (sticky-first, unread badges, last-message preview)
- Topic view: send/receive messages over Socket.IO with at-rest encryption
- Ban + mute APIs with session revocation and pubsub-driven socket disconnect
- Bot Telegram-side ban check with time-remaining message
- Admin endpoint scaffolds for topics + invites
- PWA manifest (icons not yet provided)

What's stubbed:
- Reactions persistence (event handler is a no-op)
- Bot API (slice 2)
- Auto-delete worker (schema present, worker not yet built)
- Web Push delivery (subscription model present, server not yet wired)
- Moderation queue UI (endpoints in place)
- Service worker registration
```
