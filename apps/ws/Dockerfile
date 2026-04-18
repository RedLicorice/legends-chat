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

# ── Runtime image ───────────────────────────────────────────────────────────
FROM deps AS runner
COPY packages  ./packages
COPY apps/ws   ./apps/ws
ENV NODE_ENV=production
EXPOSE 3001
CMD ["/bin/sh", "-c", "node_modules/.bin/tsx apps/ws/src/index.ts"]
