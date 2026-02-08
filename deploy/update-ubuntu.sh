#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/opt/tickr-alerts}"
BRANCH="${2:-main}"

cd "$APP_DIR"
git fetch --all --prune
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm ci
npx pm2 restart ecosystem.config.cjs
npx pm2 save
npx pm2 status
