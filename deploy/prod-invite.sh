#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${1:-.env.prod}"
[[ ! -f "$ENV_FILE" ]] && { echo "Error: $ENV_FILE not found."; exit 1; }
docker run --rm --entrypoint /app/node_modules/.bin/tsx \
  --env-file "$ENV_FILE" --network legendsnet \
  legends-chat:latest \
  /app/packages/db/src/create-invite.ts
