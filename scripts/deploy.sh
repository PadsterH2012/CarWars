#!/usr/bin/env bash
# deploy.sh — build and deploy carwars to hl-carwars (10.202.28.192)
#
# Usage:
#   ./scripts/deploy.sh
#
# What it does:
#   1. Builds the shared package, server (tsc), and client (vite)
#   2. Rsyncs built artifacts to /opt/carwars/app on the VM
#   3. Installs production dependencies on the VM
#   4. Restarts the carwars systemd service
#
# Prerequisites on the VM (already configured):
#   - Debian 13, paddy user with passwordless sudo
#   - Node 20, npm, PostgreSQL 17
#   - App disk at /opt/carwars (label: carwars-app)
#   - PostgreSQL data at /opt/carwars/postgres
#   - DB: carwars / user: carwars / pass: carwars_dev
#   - systemd service: /etc/systemd/system/carwars.service
#   - Logs: /opt/carwars/shared/logs/server.log

set -euo pipefail

HOST="paddy@10.202.28.192"
REMOTE_APP="/opt/carwars/app"
SSHPASS="P0w3rPla72012@@"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Building shared..."
cd "$REPO_ROOT/shared"
npm ci --silent
npm run build --silent

echo "==> Building server..."
cd "$REPO_ROOT/server"
npm ci --silent
npm run build --silent

echo "==> Building client..."
cd "$REPO_ROOT/client"
npm ci --silent
npm run build --silent

echo "==> Syncing to $HOST:$REMOTE_APP ..."
# Sync server build + package files
sshpass -p "$SSHPASS" rsync -az --delete \
  --exclude=node_modules \
  --exclude=src \
  --exclude='*.test.*' \
  --exclude=tests \
  "$REPO_ROOT/server/dist/" "$HOST:$REMOTE_APP/dist/"

sshpass -p "$SSHPASS" rsync -az \
  "$REPO_ROOT/server/package.json" \
  "$REPO_ROOT/server/package-lock.json" \
  "$HOST:$REMOTE_APP/"

# Sync client build output (served as static files by the server)
sshpass -p "$SSHPASS" rsync -az --delete \
  "$REPO_ROOT/client/dist/" "$HOST:$REMOTE_APP/public/"

# Sync shared dist so server can require it
sshpass -p "$SSHPASS" rsync -az --delete \
  "$REPO_ROOT/shared/dist/" "$HOST:$REMOTE_APP/shared-dist/"

echo "==> Installing production deps on VM..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" \
  "cd $REMOTE_APP && npm ci --omit=dev --silent"

echo "==> Restarting service..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" \
  "sudo systemctl restart carwars && sleep 2 && systemctl is-active carwars"

echo "==> Tail of logs:"
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" \
  "tail -20 /opt/carwars/shared/logs/server.log 2>/dev/null || echo '(no log yet)'"

echo ""
echo "Done. Server running at http://10.202.28.192:3001"
