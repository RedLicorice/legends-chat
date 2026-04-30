FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── Install all workspace dependencies (shared across apps) ─────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json     ./apps/web/
COPY apps/ws/package.json      ./apps/ws/
COPY apps/bot/package.json     ./apps/bot/
COPY packages/crypto/package.json  ./packages/crypto/
COPY packages/db/package.json      ./packages/db/
COPY packages/shared/package.json  ./packages/shared/
RUN pnpm install --frozen-lockfile

# ── Build Next.js standalone ────────────────────────────────────────────────
FROM deps AS builder
COPY . .
# Inline dummy env vars satisfy "not set" guard checks during next build's
# static page-collection phase. Values are never baked into the runner image.
RUN DATABASE_URL=postgres://build:x@localhost/build \
    REDIS_URL=redis://localhost:6379 \
    JWT_ACCESS_SECRET=build-placeholder-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
    JWT_REFRESH_SECRET=build-placeholder-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy \
    ENCRYPTION_MASTER_KEY=YnVpbGQtcGxhY2Vob2xkZXItMzItYnl0ZXMteno= \
    pnpm --filter @legends/web build

# ── Monolith runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache nginx supervisor \
 && mkdir -p /var/log/supervisor /run/nginx

WORKDIR /app
ENV NODE_ENV=production

# Web: standalone output is self-contained (includes its own minimal node_modules)
COPY --from=builder /app/apps/web/.next/standalone           /app/web/
COPY --from=builder /app/apps/web/.next/static               /app/web/apps/web/.next/static
COPY --from=builder /app/apps/web/public                     /app/web/apps/web/public

# WS + Bot: share the single root node_modules from the install stage
# Docker COPY dereferences pnpm symlinks, so workspace packages are inlined
COPY --from=builder /app/node_modules    ./node_modules

# Ensure next is resolvable from the standalone server.
# .dockerignore strips **/node_modules so the standalone's bundled node_modules
# is not present. Symlink next from the root pnpm virtual store instead.
RUN NEXT_DIR=$(ls /app/node_modules/.pnpm | grep '^next@' | head -1) && \
    ln -sf "/app/node_modules/.pnpm/${NEXT_DIR}/node_modules/next" /app/node_modules/next
COPY --from=builder /app/packages        ./packages
COPY --from=builder /app/apps/ws         ./apps/ws
COPY --from=builder /app/apps/bot        ./apps/bot
COPY --from=builder /app/package.json    /app/pnpm-workspace.yaml \
                    /app/tsconfig.base.json ./

COPY deploy/nginx.conf       /etc/nginx/nginx.conf
COPY deploy/supervisord.conf /etc/supervisord.conf
COPY deploy/entrypoint.sh    /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
