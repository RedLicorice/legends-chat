#!/usr/bin/env bash
# Legends Chat - stop all services
set -euo pipefail

cd "$(dirname "$0")"

echo "[1/3] stopping web / ws / bot (pm2)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete legends-web legends-ws legends-bot 2>/dev/null || true
fi

# Belt-and-suspenders: kill any stray dev processes pm2 may have missed.
pkill -f 'next dev' 2>/dev/null || true
pkill -f 'next-server' 2>/dev/null || true
pkill -f 'tsx watch src/index.ts' 2>/dev/null || true

echo "[2/3] stopping ngrok"
if [[ -f logs/ngrok.pid ]]; then
  pid=$(cat logs/ngrok.pid)
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "  ngrok: stopped (pid ${pid})"
  fi
  rm -f logs/ngrok.pid logs/ngrok.env
fi
pkill -f 'scripts/ngrok.mjs' 2>/dev/null || true

echo "[3/3] stopping postgres + redis"
docker compose stop

echo
echo "Stopped. Volume preserved — run 'docker compose down -v' to wipe the database."
