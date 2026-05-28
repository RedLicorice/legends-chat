#!/usr/bin/env bash
set -euo pipefail

# Make pnpm/node available under non-interactive shells (e.g. when invoked
# by automation that doesn't source ~/.bashrc). Adjust paths if your install
# differs.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found in PATH after init. PATH=$PATH" >&2
  exit 127
fi

REMOTE="stonr.club"
REMOTE_DIR="/home/mrl/chat"

echo "==> Building deploy package..."
just docker-pack

echo "==> Uploading to $REMOTE:$REMOTE_DIR..."
scp dist/legends-chat-deploy.tgz "$REMOTE:$REMOTE_DIR/"

echo "==> Deploying on $REMOTE..."
ssh "$REMOTE" bash -c "'
  set -euo pipefail
  cd $REMOTE_DIR
  echo \"--- Extracting...\"
  tar xzf legends-chat-deploy.tgz
  echo \"--- Building image...\"
  ./build.sh
  echo \"--- Starting services...\"
  ./start.sh
  echo \"--- Done.\"
'"

echo "==> Deploy complete."
