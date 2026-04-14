#!/usr/bin/env bash
# Legends Chat - stop all services
#   - kills the pids written by start.sh
#   - stops the containers (volume preserved; use `docker compose down -v` to wipe data)
set -euo pipefail

cd "$(dirname "$0")"

stop_service() {
  local name=$1
  local pidfile="logs/${name}.pid"
  if [[ ! -f "$pidfile" ]]; then
    echo "  ${name}: no pidfile"
    return
  fi
  local pid
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    # Kill the whole process group so tsx/next and their children die together.
    kill -- "-${pid}" 2>/dev/null || kill "$pid" 2>/dev/null || true
    # Fallback: tree kill by pattern for stray next-server workers.
    pkill -P "$pid" 2>/dev/null || true
    echo "  ${name}: stopped (pid ${pid})"
  else
    echo "  ${name}: not running"
  fi
  rm -f "$pidfile"
}

echo "[1/2] stopping web / ws / bot"
stop_service web
stop_service ws
stop_service bot

# Sweeper: catch any stragglers that escaped their process group.
pkill -f 'next dev' 2>/dev/null || true
pkill -f 'next-server' 2>/dev/null || true
pkill -f 'tsx watch src/index.ts' 2>/dev/null || true

echo "[2/2] stopping postgres + redis"
docker compose stop

echo
echo "Stopped. Volume preserved — run 'docker compose down -v' to wipe the database."
