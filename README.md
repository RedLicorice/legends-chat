# Legends Chat

Self-hosted community chat. Installable PWA, opt-in end-to-end
encryption, no third-party SaaS dependency. Built for groups that
want to run their own server instead of renting one.

The operator who runs the server is the root of trust. Regular
channels are server-side encrypted at rest; sensitive channels and
1:1 DMs can opt in to Matrix Olm/Megolm end-to-end encryption. See
`docs/whitepaper.md` for the full security posture and threat model
— it does not sugarcoat the limitations.

## Features

**Channels**
- Group "topic" channels with role-gated view / read / post / reply
- Feed-mode channels (bulletin-board layout, `Ctrl+Enter` to post)
- E2EE topics — Matrix Megolm via `matrix-sdk-crypto-wasm`
  (vodozemac, NCC-audited). Admin is a permanent recipient for
  moderation; this is documented in-channel and in the whitepaper.
- Per-session forward secrecy (rotation every ~1 week, 100
  messages, or membership change)
- TOFU identity pinning + safety numbers
- Locked-message UX for undecryptable rows (blurred placeholder +
  reason modal)
- Per-channel auto-delete by age or count
- Per-topic fine-grained grants (user / role / bot principals)

**DMs**
- 1:1 user↔user, plaintext or E2EE (per-conversation toggle)
- 1:1 user↔bot, plaintext or E2EE (admin opts the bot in)
- Sidebar unifies topics + DMs + bot DMs into one chat list with
  filter chips (All / Topics / DMs / Bots) and a search bar
- Delete conversation — hide-for-me (re-shows on new message) or
  delete-for-both
- DM URL is `/c/<id>`

**Bots**
- API for sending messages, polls, inline keyboards
- Per-bot E2EE state machine: `disabled` → `pending` (bot SDK
  bootstrapping Olm device) → `ready`. Toggled by an admin in
  `/admin/bots`.
- Topic membership (including E2EE topics, once `ready`)
- Outbound webhook for inbound messages
- Bot SDK is a separate package (`@legends/bot-sdk`) for running
  bots off the chat server's infrastructure

**Auth**
- Passkeys (WebAuthn / FIDO2) — primary, phishing-resistant
- Email + bcrypt password, optional TOTP 2FA
- Telegram magic link
- Short-lived JWT access tokens + hashed refresh tokens; per-user
  revocation through an in-memory revocation list

**PWA**
- Installable on iOS, Android, desktop (Chrome / Edge)
- Single persistent client shell — cold-launch splash once,
  intra-app navigation never tears chrome or the live socket
- Mobile full-screen drill-down (list → chat → thread) with Back;
  multi-pane on tablet/desktop
- Embedded-webview gate — detects in-app browsers (Telegram, etc.)
  and prompts to open in a real browser for passkeys + push
- Service worker caches the app shell; push notifications route
  through your community's own VAPID keys

**Privacy & moderation**
- XChaCha20-Poly1305 at-rest encryption on all message bodies
- Upload pipeline strips EXIF/XMP/ICC/GPS client-side, verifies
  server-side, rate-limits original-quality opt-outs
- Tracking-parameter strip on every outbound URL
  (`utm_*`, `fbclid`, `gclid`, ...) client + server
- External-link interstitial with whitelistable hosts
- Optional Shlink integration for self-hosted link shortening
- Moderation queue, bans, mutes, audit log

**Deploy**
- Self-hosted Docker bundle: build once, ship a tgz, run
  `./build.sh && ./start.sh` on the target. No SaaS dependency.

## Tech stack

| Concern | Choice |
|---|---|
| Web app | Next.js 15 (App Router, strict SPA) |
| Realtime | Socket.IO + Redis pub/sub (`apps/ws`) |
| Bot runtime | grammY (`apps/bot`, the Telegram bot) |
| DB | PostgreSQL + Drizzle ORM (`packages/db`) |
| Cache / session / fan-out | Redis (ioredis) |
| At-rest encryption | XChaCha20-Poly1305 (`packages/crypto`) |
| End-to-end encryption | Matrix Olm/Megolm via `@matrix-org/matrix-sdk-crypto-wasm` 18.x |
| Auth | passkeys (`@simplewebauthn`), bcrypt, TOTP, JWT (`jose`) |
| Editor | TipTap 3 |

## Local development

```bash
cp .env.example .env
# Fill in secrets — at minimum DATABASE_URL, REDIS_URL,
# JWT_*_SECRET, ENCRYPTION_MASTER_KEY (see comments in .env.example).

pnpm install
just dev
```

`just dev` brings up postgres + redis (via `docker-compose.yml`),
runs migrations, and starts web, ws, and bot in one foreground
process. Ctrl+C stops everything.

Common recipes:

| Recipe | What it does |
|---|---|
| `just dev` | Full dev stack: infra + web + ws + bot |
| `just infra-up` / `infra-down` | Just postgres + redis containers |
| `just web` / `ws` / `bot` | Run one app in isolation |
| `just migrate` | Apply DB migrations |
| `just prebuild` | Production build (no server) |
| `just docker-pack` | Build artifacts + pack `dist/legends-chat-deploy.tgz` |
| `just tls-up` / `tls-url` | ngrok tunnel for mobile testing |

## Production deployment

```bash
# On your machine
just docker-pack
scp dist/legends-chat-deploy.tgz target:~/

# On target
tar xzf legends-chat-deploy.tgz
cp .env.prod.example .env.prod   # fill in all secrets
./build.sh                        # build runtime image (native arch)
./start.sh                        # start
./stop.sh                         # stop
./cleanup.sh                      # stop + remove image + volumes (destructive)
```

Requires an external Postgres and Redis — set `DATABASE_URL` and
`REDIS_URL` in `.env.prod`. The runtime image is built from packed
JS artifacts, not the source tree; everything secret must be
mapped explicitly in `.env.prod` and `docker-compose.prod.yml`.

First deploy:

```bash
./seed.sh you@example.com yourpassword   # create the first admin
./invite.sh                               # generate a single-use invite (printed to stdout)
```

`invite.sh` also enables email registration + invite-only mode if
not already set.

## Documentation

Three docs ship in this repo and inside the running app:

| Doc | File | Served at | Visibility |
|---|---|---|---|
| Privacy & Security Whitepaper | `docs/whitepaper.md` | `/docs/whitepaper` | Public |
| User Manual | `docs/manual.md` | `/docs/manual` | Authed users |
| Administrator Manual | `docs/admin-manual.md` | `/docs/admin-manual` | Admins only |

Each manual has a mirror under `apps/web/public/docs/` that the
`/docs/[slug]` route reads — the source-of-truth copy lives in
`docs/`, and the mirror must stay in sync.

Dated release notes live in `docs/changelogs/`; a post-ready,
non-technical summary for end users is
`docs/changelogs/CHANGELOG-USERS-2026-07.md`.

## Repository layout

```
apps/
  web/          Next.js PWA — auth, topics, DMs, admin, E2EE client
  ws/           Socket.IO server — JWT auth, Redis pub/sub fan-out
  bot/          grammY Telegram bot — /start, registration, login links
packages/
  db/           Drizzle schema, migrations, seed helpers
  shared/       zod schemas, permission keys, event names, error codes
  crypto/       XChaCha20-Poly1305 at-rest helpers
  bot-sdk/      Bot SDK — HTTP client + Olm machine for E2EE bots
deploy/
  nginx.conf, supervisord.conf, entrypoint.sh
  prod-*.sh     Source scripts (packed into the deploy tgz as *.sh)
docs/
  whitepaper.md, manual.md, admin-manual.md
  superpowers/  Specs, plans, internal design docs
```
