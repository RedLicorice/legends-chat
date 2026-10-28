#!/bin/sh
# Unlock /install for a short time (single use). Run inside the AIO container:
#   docker exec -it legends-aio install-unlock [--force] [--ttl-minutes N]
# DATABASE_URL is built the same way entrypoint-aio.sh does: docker exec does
# not inherit variables the entrypoint exported.
set -e
export DATABASE_URL="postgres://${DB_USER:-legends}:${DB_PASS:-legends}@127.0.0.1:5432/${DB_NAME:-legends}"
cd /app/packages/db
exec /app/node_modules/.bin/tsx src/install-unlock.ts "$@"
