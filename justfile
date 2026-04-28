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

clearlogs:
    pm2 flush
    rm -f logs/*.log logs/ngrok.env
    @echo "logs cleared"

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
