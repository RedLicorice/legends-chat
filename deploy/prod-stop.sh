#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${1:-.env.prod}"

echo "==> Stopping..."
docker compose -f docker-compose.prod.yml --env-file "$ENV_FILE" down

echo "Stopped. Data volumes preserved."
echo "  Run ./cleanup.sh to also remove the image and volumes."
