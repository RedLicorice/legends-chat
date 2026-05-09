#!/usr/bin/env bash
set -euo pipefail

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
