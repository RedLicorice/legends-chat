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

dev:
    pnpm --filter @legends/web run dev

prebuild:
    pnpm --filter @legends/web run build

dev-warm: prebuild dev

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
