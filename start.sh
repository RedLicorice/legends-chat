#!/usr/bin/env bash
# Legends Chat - start all services
#   - brings up postgres + redis via docker compose
#   - runs web / ws / bot in the background, each logged to logs/<name>.log
#   - writes PIDs to logs/<name>.pid so stop.sh can kill them cleanly
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p logs

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
else
  echo ".env not found (copy .env.example and fill in secrets)" >&2
  exit 1
fi

echo "[1/4] postgres + redis"
docker compose up -d

start_service() {
  local name=$1 pkg=$2
  if [[ -f "logs/${name}.pid" ]] && kill -0 "$(cat "logs/${name}.pid")" 2>/dev/null; then
    echo "  ${name} already running (pid $(cat "logs/${name}.pid")) — skipping"
    return
  fi
  echo "  ${name}: pnpm --filter ${pkg} dev → logs/${name}.log"
  nohup pnpm --filter "${pkg}" dev >"logs/${name}.log" 2>&1 &
  echo $! >"logs/${name}.pid"
}

echo "[2/4] web"
start_service web @legends/web
echo "[3/4] ws"
start_service ws @legends/ws
echo "[4/4] bot"
start_service bot @legends/bot

echo
echo "All services launched."
echo "  web → http://localhost:3000"
echo "  ws  → http://localhost:3001"
echo "  logs → logs/{web,ws,bot}.log"
echo
echo "Stop with: ./stop.sh"
