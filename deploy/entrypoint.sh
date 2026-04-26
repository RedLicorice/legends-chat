#!/bin/sh
set -e

: "${DATABASE_URL:?DATABASE_URL is required}"

echo "==> Running database migrations..."
cd /app/packages/db
DATABASE_URL="${DATABASE_URL}" /app/node_modules/.bin/tsx src/migrate.ts

echo "==> Starting services..."
exec /usr/bin/supervisord -n -c /etc/supervisord.conf
