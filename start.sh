#!/usr/bin/env bash
# Legends Chat - start all services via pm2
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

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found. Install with: npm install -g pm2" >&2
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

# Point Node at the system CA bundle. Without this, fetch() to api.telegram.org
# and other HTTPS endpoints fails on hosts whose Node build doesn't trust the
# local cert chain. PM2 picks this up via --update-env on reload, or via the
# captured environ on fresh start.
if [[ -f /etc/ssl/certs/ca-certificates.crt ]]; then
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
fi

echo "[1/4] postgres + redis"
docker compose up -d

# --- optional ngrok tunnel ---
NGROK_WEB_URL="http://localhost:3000"

if [[ "${NGROK_ENABLE:-}" == "false" ]]; then
  echo "[2/4] ngrok — disabled (NGROK_ENABLE=false)"
  rm -f logs/ngrok.env logs/ngrok.pid
elif [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "[2/4] ngrok"
  if [[ -f logs/ngrok.pid ]] && kill -0 "$(cat logs/ngrok.pid)" 2>/dev/null; then
    echo "  ngrok already running (pid $(cat logs/ngrok.pid)) — reusing existing tunnels"
  else
    rm -f logs/ngrok.env logs/ngrok.pid
    nohup node scripts/ngrok.mjs >"logs/ngrok.log" 2>&1 &
    echo $! >"logs/ngrok.pid"
  fi

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
    echo "  web tunnel → ${NGROK_WEB_URL}"
  else
    echo "  ngrok didn't start in time — continuing on localhost"
  fi
else
  echo "[2/4] ngrok — skipped (NGROK_AUTHTOKEN not set)"
fi

echo "[3/4] web / ws / bot (pm2)"
# If apps are already in pm2, reload them; otherwise start fresh.
if pm2 id legends-web &>/dev/null; then
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

echo "[4/4] saving pm2 process list"
pm2 save

echo
echo "All services launched."
if [[ "${NGROK_ENABLE:-}" != "false" && -n "${NGROK_AUTHTOKEN:-}" && -f logs/ngrok.env ]]; then
  echo "  web → ${NGROK_WEB_URL}  (also http://localhost:3000)"
  echo "  ws  → proxied via /socket.io/* on web"
else
  echo "  web → http://localhost:3000"
  echo "  ws  → http://localhost:3001"
fi
echo
echo "  status  → pm2 status"
echo "  logs    → pm2 logs"
echo "  stop    → ./stop.sh"
