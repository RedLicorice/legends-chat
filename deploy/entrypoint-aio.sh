#!/bin/sh
set -e

DB_USER="${DB_USER:-legends}"
DB_PASS="${DB_PASS:-legends}"
DB_NAME="${DB_NAME:-legends}"

export DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

# ── PostgreSQL initialisation ───────────────────────────────────────────────
if [ ! -f "${PGDATA}/PG_VERSION" ]; then
    echo "==> [aio] First boot: initialising PostgreSQL data directory..."
    mkdir -p "${PGDATA}"
    chown postgres:postgres "${PGDATA}"
    chmod 700 "${PGDATA}"
    su postgres -s /bin/sh -c "initdb -D '${PGDATA}' --auth-local=trust --auth-host=md5 --username=postgres"
    # Allow TCP from localhost (required for the app to connect via 127.0.0.1)
    echo "host all all 127.0.0.1/32 md5" >> "${PGDATA}/pg_hba.conf"
fi

# Start PostgreSQL temporarily for user/db creation and migrations
echo "==> [aio] Starting PostgreSQL for initialisation..."
su postgres -s /bin/sh -c \
    "pg_ctl -D '${PGDATA}' -w -t 60 start -o '-c listen_addresses=127.0.0.1 -c log_min_messages=WARNING'"

# Create app role and database if they don't exist yet (idempotent)
ROLE_EXISTS=$(su postgres -s /bin/sh -c \
    "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'\"" 2>/dev/null || echo "")
if [ "${ROLE_EXISTS}" != "1" ]; then
    echo "==> [aio] Creating database role '${DB_USER}'..."
    su postgres -s /bin/sh -c "psql -c \"CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';\""
    su postgres -s /bin/sh -c "psql -c \"CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};\""
fi

# Run migrations (Drizzle tracks applied migrations — safe on every boot)
echo "==> [aio] Running database migrations..."
cd /app/packages/db
DATABASE_URL="${DATABASE_URL}" /app/node_modules/.bin/tsx src/migrate.ts

# Stop the temporary PostgreSQL — supervisord will start it cleanly
echo "==> [aio] Stopping temporary PostgreSQL..."
su postgres -s /bin/sh -c "pg_ctl -D '${PGDATA}' -w -t 60 stop -m fast"

# ── Hand off to supervisord ─────────────────────────────────────────────────
echo "==> [aio] Starting all services..."
exec /usr/bin/supervisord -n -c /etc/supervisord.conf
