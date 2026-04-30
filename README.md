# Legends Chat

Community PWA chat.

## Stack

- Next.js 15 (App Router) PWA — `apps/web`
- Socket.IO + Redis adapter — `apps/ws`
- grammY Telegram bot — `apps/bot`
- Postgres + Drizzle ORM — `packages/db`
- Shared zod / permissions / events — `packages/shared`
- XChaCha20-Poly1305 at-rest encryption — `packages/crypto`

## Local dev

```bash
cp .env.example .env
# fill in secrets (see .env.example for instructions)

pnpm install
docker compose up -d   # postgres + redis
just migrate           # apply migrations
just dev               # web :3000, ws :3001, bot
```

`just dev-warm` runs a full build first (avoids slow first page loads).

## Auth

Supported login methods: **passkey**, **email/password**, **Telegram**.  
Passkey is the primary method. E2EE keys are backed up via WebAuthn PRF extension.

## Production deployment

### 1. Build the deploy package (on your machine)

```bash
just docker-pack
# outputs dist/legends-chat-deploy.tgz
```

### 2. Transfer to target

```bash
scp dist/legends-chat-deploy.tgz user@target:~/
```

### 3. On target

```bash
tar xzf legends-chat-deploy.tgz
cp .env.prod.example .env.prod   # fill in all secrets
./build.sh                        # build image (native arch)
./start.sh                        # start
./stop.sh                         # stop
./cleanup.sh                      # stop + remove image + volumes (destructive)
```

Requires an external Postgres and Redis — set `DATABASE_URL` and `REDIS_URL` in `.env.prod`.  
The app joins Docker network `legendsnet` (created automatically by `start.sh`).

### 4. First deploy

```bash
./seed.sh you@example.com yourpassword   # create admin account
./invite.sh                               # generate a single-use invite code (printed to stdout)
```

`invite.sh` also enables email registration + invite-only mode if not already set.

## Layout

```
apps/
  web/        Next.js PWA — auth, topics, admin, E2EE
  ws/         Socket.IO server — JWT auth, Redis pubsub
  bot/        grammY Telegram bot — /start, registration, login links
packages/
  db/         Drizzle schema, migrations, seed helpers
  shared/     zod schemas, permission keys, event names
  crypto/     at-rest encryption helpers
deploy/
  nginx.conf, supervisord.conf, entrypoint.sh
  prod-*.sh   source scripts (packed into deploy tgz as *.sh)
```

## justfile recipes

| Recipe | What it does |
|---|---|
| `just dev` | Start Next.js dev server |
| `just prebuild` | Production build (no server) |
| `just dev-warm` | Build then dev |
| `just migrate` | Run DB migrations |
| `just docker-pack` | Build JS artifacts + pack deploy tgz |
