#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

echo "==> Building web app..."
pnpm --filter web build

echo "==> Reloading PM2..."
pm2 reload ecosystem.config.cjs --only legends-web

echo "==> Done."
pm2 logs legends-web --lines 10 --nostream
