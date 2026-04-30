#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${1:-.env.prod}"

echo "WARNING: This will stop all containers and DELETE all data volumes."
read -r -p "Type YES to continue: " confirm
if [[ "$confirm" != "YES" ]]; then
  echo "Aborted."
  exit 0
fi

echo "==> Stopping and removing containers + volumes..."
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" down -v

echo "==> Removing image..."
docker rmi legends-chat:latest 2>/dev/null || true

echo "Done. Everything removed."
