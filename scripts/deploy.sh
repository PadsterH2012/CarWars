#!/usr/bin/env bash
# deploy.sh — deploy carwars to hl-carwars (10.202.28.192)
#
# Usage:
#   ./scripts/deploy.sh
#
# Process:
#   1. Rsync source to VM (excludes node_modules, build artifacts)
#   2. npm install on VM (resolves native deps for x86_64 Linux)
#   3. Build server (esbuild) and client (vite) on VM
#   4. Restart carwars systemd service
#
# Prerequisites on the VM (already configured):
#   - Debian 13, paddy user with passwordless sudo
#   - Node 20, npm, PostgreSQL 17, rsync
#   - App disk at /opt/carwars (label: carwars-app), mounted at /opt/carwars
#   - PostgreSQL data dir: /opt/carwars/postgres
#   - DB: carwars / user: carwars / pass: carwars_dev
#   - systemd: /etc/systemd/system/carwars.service (runs node dist/main.js as paddy)
#   - Logs: /opt/carwars/shared/logs/server.log

set -euo pipefail

HOST="paddy@10.202.28.192"
REMOTE_SRC="/opt/carwars/src"
REMOTE_APP="/opt/carwars/app"
SSHPASS="P0w3rPla72012@@"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Syncing source to $HOST:$REMOTE_SRC ..."
sshpass -p "$SSHPASS" rsync -az --delete \
  --exclude=node_modules \
  --exclude='*/dist' \
  --exclude='.git' \
  --exclude='test-results' \
  --exclude='e2e' \
  "$REPO_ROOT/" "$HOST:$REMOTE_SRC/"

echo "==> Installing dependencies on VM..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" "bash -s" << 'REMOTE'
set -e
cd /opt/carwars/src
npm install --silent
REMOTE

echo "==> Building on VM..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" "bash -s" << 'REMOTE'
set -e
cd /opt/carwars/src/server
npm run build

cd /opt/carwars/src/client
npm run build
REMOTE

echo "==> Copying build artifacts to app dir..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" "bash -s" << 'REMOTE'
set -e
mkdir -p /opt/carwars/app/dist /opt/carwars/app/public
cp /opt/carwars/src/server/dist/main.js /opt/carwars/app/dist/
rsync -a --delete /opt/carwars/src/client/dist/ /opt/carwars/app/public/
# node_modules from workspace root (npm hoists deps there)
rsync -a --delete /opt/carwars/src/node_modules/ /opt/carwars/app/node_modules/
cp /opt/carwars/src/server/package.json /opt/carwars/app/
REMOTE

echo "==> Restarting service..."
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" \
  "sudo systemctl restart carwars && sleep 2 && systemctl is-active carwars"

echo "==> Tail of logs:"
sshpass -p "$SSHPASS" ssh -o StrictHostKeyChecking=no "$HOST" \
  "tail -20 /opt/carwars/shared/logs/server.log 2>/dev/null || echo '(no log yet)'"

echo ""
echo "Done. Server at http://10.202.28.192:3001"
