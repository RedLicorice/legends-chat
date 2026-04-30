#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${1:-.env.prod}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found." >&2
  echo "  cp .env.prod.example .env.prod  # then fill in secrets" >&2
  exit 1
fi

echo "==> Ensuring network legendsnet exists..."
docker network create legendsnet 2>/dev/null || true

echo "==> Starting..."
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" up -d

echo ""
echo "Running. Useful commands:"
echo "  ./seed.sh you@example.com password  - create admin account (first deploy)"
echo "  ./stop.sh                           - stop"
echo "  ./cleanup.sh                        - stop + remove image + volumes"
echo "  docker compose -f docker-compose.prod.yml logs -f"
