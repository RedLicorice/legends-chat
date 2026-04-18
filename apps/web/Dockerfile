FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ── Install dependencies ────────────────────────────────────────────────────
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

# ── Build Next.js ───────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN pnpm --filter @legends/web build

# ── Standalone runtime image ────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

# standalone output bundles its own minimal node_modules
COPY --from=builder /app/apps/web/.next/standalone           ./
COPY --from=builder /app/apps/web/.next/static               ./apps/web/.next/static
COPY --from=builder /app/apps/web/public                     ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
