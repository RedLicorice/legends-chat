#!/usr/bin/env bash
# Usage: ./seed.sh admin@example.com yourpassword
set -euo pipefail
cd "$(dirname "$0")"

EMAIL="${1:?Usage: ./seed.sh email password}"
PASSWORD="${2:?Usage: ./seed.sh email password}"
ENV_FILE="${3:-.env.prod}"

[[ ! -f "$ENV_FILE" ]] && { echo "Error: $ENV_FILE not found."; exit 1; }

docker run --rm --entrypoint /app/node_modules/.bin/tsx \
  --env-file "$ENV_FILE" --network legendsnet \
  legends-chat:latest \
  /app/packages/db/src/create-admin.ts "$EMAIL" "$PASSWORD"
