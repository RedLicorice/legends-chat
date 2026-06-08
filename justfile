default:
    @just --list

install:
    #!/usr/bin/env bash
    if command -v pnpm >/dev/null 2>&1; then
        pnpm install
    elif command -v corepack >/dev/null 2>&1; then
        corepack pnpm install
    else
        echo "pnpm not found. Run: npm install -g pnpm" >&2
        exit 1
    fi

# `just dev` — single command that brings up EVERYTHING and auto-reloads
# every code change. Starts (or reuses) postgres + redis containers, then
# runs web (next dev --turbo), ws (tsx watch), and bot (tsx watch) in a
# single foreground process. Ctrl+C stops them all together.
#
# What auto-reloads:
#   - Web    : next dev --turbo handles HMR + RSC + server route reloads.
#   - WS     : tsx watch restarts the daemon on file change.
#   - Bot    : tsx watch restarts the daemon on file change.
#   - Shared packages (@legends/db, @legends/shared, @legends/crypto) are
#     pnpm symlinks; tsx watch follows the symlinks; turbopack transpiles
#     them under `transpilePackages`.
dev: infra-up
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; source .env; set +a; fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi
    # --parallel keeps all three running; --stream prefixes each line with
    # the package name so output stays legible.
    pnpm -r --parallel --stream --filter "./apps/*" run dev

# Alias for muscle memory. Same behaviour as `just dev`.
dev-warm: dev

# Bring up dev infra: postgres + redis containers, wait for healthy.
infra-up:
    docker compose up -d --wait

infra-down:
    docker compose down

infra-logs:
    docker compose logs -f --tail=100

# Run a single app's dev script. Use this only when you want to run web,
# ws, or bot in isolation — `just dev` runs all three at once.
web:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; source .env; set +a; fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi
    pnpm --filter @legends/web run dev

ws:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; source .env; set +a; fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi
    pnpm --filter @legends/ws run dev

bot:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; source .env; set +a; fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi
    pnpm --filter @legends/bot run dev

# Production web build (only when something explicitly needs the .next/
# output — `just dev` skips this because Next dev compiles on demand).
prebuild:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f .env ]; then set -a; source .env; set +a; fi
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt; fi
    pnpm --filter @legends/web run build

# Migrate DB then start the full stack.
dev-stack: infra-up migrate dev

start:
    ./start.sh

stop:
    ./stop.sh

restart: stop start

status:
    pm2 status

logs:
    pm2 logs

migrate:
    pnpm --filter @legends/db run migrate

# Rotate JWT signing secrets in .env. Invalidates all sessions.
rotate-secrets:
    ./scripts/rotate-secrets.sh

clearlogs:
    pm2 flush
    rm -f logs/*.log logs/ngrok.env
    @echo "logs cleared"

# ── Tailscale TLS for LAN/tailnet dev (WebAuthn needs Secure Context) ────────

# Front next dev with Tailscale-issued TLS on :443. Internal Next rewrites
# proxy /socket.io/* → ws (3001) and /bot/webhook → bot (3002), so only :3000
# is fronted. Prereq: HTTPS Certificates enabled at
# https://login.tailscale.com/admin/dns and `just dev-warm` running.
tls-up:
    sudo tailscale serve --bg --https=443 http://localhost:3000

tls-down:
    sudo tailscale serve reset

tls-status:
    tailscale serve status

# Print the https URL to hand to clients on the tailnet.
tls-url:
    #!/usr/bin/env bash
    set -euo pipefail
    name=$(tailscale status --self --peers=false --json | grep -oE '"DNSName":\s*"[^"]+"' | head -n1 | sed -E 's/.*"DNSName":\s*"([^"]+)\.?"/\1/')
    echo "https://${name%.}"

# ── Docker / Production ───────────────────────────────────────────────────────

# Build JS artifacts locally (platform-independent) and pack a deploy bundle.
# On target: tar xzf legends-chat-deploy.tgz
#            docker build -f Dockerfile.runtime -t legends-chat:latest .
#            cp .env.prod.example .env.prod  # fill in secrets
#            docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
docker-pack:
    #!/usr/bin/env bash
    set -euo pipefail

    echo "==> Building Next.js..."
    DATABASE_URL=postgres://build:x@localhost/build \
    REDIS_URL=redis://localhost:6379 \
    JWT_ACCESS_SECRET=build-placeholder-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
    JWT_REFRESH_SECRET=build-placeholder-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy \
    ENCRYPTION_MASTER_KEY=YnVpbGQtcGxhY2Vob2xkZXItMzItYnl0ZXMteno= \
    pnpm --filter @legends/web build

    echo "==> Staging artifacts..."
    rm -rf dist/artifacts
    mkdir -p dist/artifacts

    # Next.js standalone — platform-independent JS
    cp -r apps/web/.next/standalone       dist/artifacts/standalone
    cp -r apps/web/.next/static           dist/artifacts/static
    cp -r apps/web/public                 dist/artifacts/public

    # ws + bot source + workspace packages — pnpm install runs on target for native deps
    # exclude node_modules (platform-specific binaries must be installed on target)
    rsync -a --exclude='node_modules' packages/ dist/artifacts/packages/
    rsync -a --exclude='node_modules' apps/ws/  dist/artifacts/ws/
    rsync -a --exclude='node_modules' apps/bot/ dist/artifacts/bot/
    # include apps/web/package.json so pnpm workspace can resolve all members
    mkdir -p dist/artifacts/web
    cp apps/web/package.json              dist/artifacts/web/package.json
    cp    package.json                    dist/artifacts/package.json
    cp    pnpm-workspace.yaml             dist/artifacts/pnpm-workspace.yaml
    cp    pnpm-lock.yaml                  dist/artifacts/pnpm-lock.yaml
    cp    tsconfig.base.json              dist/artifacts/tsconfig.base.json

    echo "==> Packing dist/legends-chat-deploy.tgz..."
    # Dockerfile.runtime becomes Dockerfile so docker-compose.prod.yml works as-is
    cp Dockerfile.runtime              dist/Dockerfile
    cp docker-compose.prod.yml         dist/docker-compose.prod.yml
    cp .env.prod.example               dist/.env.prod.example
    cp deploy/prod-start.sh            dist/start.sh
    cp deploy/prod-stop.sh             dist/stop.sh
    cp deploy/prod-cleanup.sh          dist/cleanup.sh
    cp deploy/prod-build.sh            dist/build.sh
    cp deploy/prod-seed.sh             dist/seed.sh
    cp deploy/prod-invite.sh           dist/invite.sh
    chmod +x dist/build.sh dist/start.sh dist/stop.sh dist/cleanup.sh dist/seed.sh dist/invite.sh
    cp -r deploy                       dist/deploy
    tar -czf dist/legends-chat-deploy.tgz -C dist \
        artifacts Dockerfile docker-compose.prod.yml .env.prod.example \
        build.sh start.sh stop.sh cleanup.sh seed.sh invite.sh deploy
    rm -rf dist/artifacts dist/Dockerfile dist/docker-compose.prod.yml \
           dist/.env.prod.example dist/build.sh dist/start.sh dist/stop.sh dist/cleanup.sh \
           dist/seed.sh dist/invite.sh dist/deploy

    echo "==> Done: dist/legends-chat-deploy.tgz ($(du -sh dist/legends-chat-deploy.tgz | cut -f1))"
    echo ""
    echo "    scp dist/legends-chat-deploy.tgz user@target:~/"
    echo "    # on target:"
    echo "    tar xzf legends-chat-deploy.tgz"
    echo "    cp .env.prod.example .env.prod    # fill in secrets"
    echo "    ./start.sh                        # build image + start"
    echo "    ./seed.sh you@example.com password # create admin account"
    echo "    ./stop.sh / ./cleanup.sh"

# ── Bots ──────────────────────────────────────────────────────────────────────

bot-jane:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${JANE_BOT_TOKEN:?JANE_BOT_TOKEN required}" \
    WEBHOOK_URL="${JANE_WEBHOOK_URL:-}" \
    WEBHOOK_PORT="${JANE_WEBHOOK_PORT:-}" \
    pnpm --filter @legends/bot-jane run start

bot-jane-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${JANE_BOT_TOKEN:?JANE_BOT_TOKEN required}" \
    WEBHOOK_URL="${JANE_WEBHOOK_URL:-}" \
    WEBHOOK_PORT="${JANE_WEBHOOK_PORT:-}" \
    pnpm --filter @legends/bot-jane run dev

bot-chaos-alpha:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${CHAOS_ALPHA_TOKEN:?CHAOS_ALPHA_TOKEN required}" \
    BOT_INSTANCE=alpha \
    BOT_TOPICS="${CHAOS_ALPHA_TOPICS:?CHAOS_ALPHA_TOPICS required}" \
    MIN_DELAY_MS="${CHAOS_MIN_DELAY_MS:-15000}" \
    MAX_DELAY_MS="${CHAOS_MAX_DELAY_MS:-60000}" \
    pnpm --filter @legends/bot-chaos run start

bot-chaos-beta:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${CHAOS_BETA_TOKEN:?CHAOS_BETA_TOKEN required}" \
    BOT_INSTANCE=beta \
    BOT_TOPICS="${CHAOS_BETA_TOPICS:?CHAOS_BETA_TOPICS required}" \
    MIN_DELAY_MS="${CHAOS_MIN_DELAY_MS:-15000}" \
    MAX_DELAY_MS="${CHAOS_MAX_DELAY_MS:-60000}" \
    pnpm --filter @legends/bot-chaos run start

bot-chaos-alpha-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${CHAOS_ALPHA_TOKEN:?CHAOS_ALPHA_TOKEN required}" \
    BOT_INSTANCE=alpha \
    BOT_TOPICS="${CHAOS_ALPHA_TOPICS:?CHAOS_ALPHA_TOPICS required}" \
    MIN_DELAY_MS="${CHAOS_MIN_DELAY_MS:-15000}" \
    MAX_DELAY_MS="${CHAOS_MAX_DELAY_MS:-60000}" \
    pnpm --filter @legends/bot-chaos run dev:alpha

bot-chaos-beta-dev:
    #!/usr/bin/env bash
    set -euo pipefail
    BOT_TOKEN="${CHAOS_BETA_TOKEN:?CHAOS_BETA_TOKEN required}" \
    BOT_INSTANCE=beta \
    BOT_TOPICS="${CHAOS_BETA_TOPICS:?CHAOS_BETA_TOPICS required}" \
    MIN_DELAY_MS="${CHAOS_MIN_DELAY_MS:-15000}" \
    MAX_DELAY_MS="${CHAOS_MAX_DELAY_MS:-60000}" \
    pnpm --filter @legends/bot-chaos run dev:beta
