#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <repo_url> [app_dir] [branch]"
  echo "Example: $0 git@github.com:you/tickr-alerts.git /opt/tickr-alerts main"
  exit 1
fi

REPO_URL="$1"
APP_DIR="${2:-/opt/tickr-alerts}"
BRANCH="${3:-main}"

echo "[1/7] Installing base packages"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates build-essential

echo "[2/7] Installing Node.js 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "[3/7] Cloning or updating repo"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
  git fetch --all --prune
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  sudo mkdir -p "$(dirname "$APP_DIR")"
  sudo rm -rf "$APP_DIR"
  sudo git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  sudo chown -R "$USER:$USER" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "[4/7] Installing dependencies"
npm ci

echo "[5/7] Creating .env if missing"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "[6/7] Starting PM2 apps"
npx pm2 start ecosystem.config.cjs
npx pm2 save

echo "[7/7] Enable PM2 on boot"
npx pm2 startup systemd -u "$USER" --hp "$HOME" | tee /tmp/pm2-startup.txt
echo
echo "Run the sudo command printed above, then run:"
echo "  cd $APP_DIR && npx pm2 save"
echo
echo "Current PM2 status:"
npx pm2 status
