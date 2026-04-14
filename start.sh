#!/usr/bin/env bash
# Legends Chat - start all services
#   - brings up postgres + redis via docker compose
#   - runs web / ws / bot in the background, each logged to logs/<name>.log
#   - writes PIDs to logs/<name>.pid so stop.sh can kill them cleanly
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p logs

# Load nvm so Node/pnpm are on PATH even in non-interactive shells.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install via nvm (see README) and try again." >&2
  exit 1
fi
# Ensure pnpm resolves to the WSL-side binary, not /mnt/c/Program Files/nodejs/pnpm.
PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" || "$PNPM_BIN" == /mnt/c/* ]]; then
  echo "pnpm not found on the WSL side (found: ${PNPM_BIN:-none})." >&2
  echo "Install it with: npm install -g pnpm@9" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
else
  echo ".env not found (copy .env.example and fill in secrets)" >&2
  exit 1
fi

echo "[1/5] postgres + redis"
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

# --- optional ngrok tunnel ---
NGROK_WEB_URL="http://localhost:3000"
NGROK_WS_URL="http://localhost:3001"

if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "[2/5] ngrok"
  rm -f logs/ngrok.env
  nohup node scripts/ngrok.mjs >"logs/ngrok.log" 2>&1 &
  echo $! >"logs/ngrok.pid"

  # Wait up to 15 s for the tunnel URLs to be written.
  for _i in $(seq 1 30); do
    sleep 0.5
    [[ -f logs/ngrok.env ]] && break
  done

  if [[ -f logs/ngrok.env ]]; then
    set -a
    # shellcheck disable=SC1091
    . logs/ngrok.env
    set +a
    NGROK_WEB_URL="${APP_PUBLIC_URL}"
    NGROK_WS_URL="${NEXT_PUBLIC_WS_URL}"
    echo "  web tunnel → ${NGROK_WEB_URL}"
    echo "  ws  tunnel → ${NGROK_WS_URL}"
  else
    echo "  ngrok didn't start in time — continuing on localhost"
  fi
else
  echo "[2/5] ngrok — skipped (NGROK_AUTHTOKEN not set)"
fi

echo "[3/5] web"
start_service web @legends/web
echo "[4/5] ws"
start_service ws @legends/ws
echo "[5/5] bot"
start_service bot @legends/bot

echo
echo "All services launched."
if [[ -n "${NGROK_AUTHTOKEN:-}" && -f logs/ngrok.env ]]; then
  echo "  web → ${NGROK_WEB_URL}  (also http://localhost:3000)"
  echo "  ws  → ${NGROK_WS_URL}  (also http://localhost:3001)"
else
  echo "  web → http://localhost:3000"
  echo "  ws  → http://localhost:3001"
fi
echo "  logs → logs/{web,ws,bot}.log"
echo
echo "Stop with: ./stop.sh"
