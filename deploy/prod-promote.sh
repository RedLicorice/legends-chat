#!/usr/bin/env bash
# Promote an existing user to admin by email.
# Usage: ./promote.sh user@example.com [env-file]
set -euo pipefail
cd "$(dirname "$0")"

EMAIL="${1:?Usage: ./promote.sh user@example.com}"
ENV_FILE="${2:-.env.prod}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found." >&2
  exit 1
fi

DB_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
if [[ -z "$DB_URL" ]]; then
  echo "Error: DATABASE_URL not found in $ENV_FILE" >&2
  exit 1
fi

echo "==> Promoting $EMAIL to admin..."
docker run --rm \
  --network legendsnet \
  postgres:16-alpine \
  psql "$DB_URL" -c "UPDATE users SET role = 'admin' WHERE email = '${EMAIL}'; SELECT id, email, role FROM users WHERE email = '${EMAIL}';"
