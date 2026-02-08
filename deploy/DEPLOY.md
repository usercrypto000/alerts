# VPS Deployment (Ubuntu)

## What this gives you
- `tickr-main` and `tickr-contract` running under PM2
- auto-restart on crash
- auto-start after server reboot (once PM2 startup is finalized)

## One-time setup
Run on the VPS as your deploy user:

```bash
bash deploy/provision-ubuntu.sh <repo_url> /opt/tickr-alerts main
```

## Required manual steps (you)
1. Fill `/opt/tickr-alerts/.env` with real secrets and RPC keys.
2. Run the `sudo ... pm2 startup ...` command printed by `provision-ubuntu.sh`.
3. Save process list again:
```bash
cd /opt/tickr-alerts
npx pm2 save
```

## Verify runtime
```bash
cd /opt/tickr-alerts
npx pm2 status
npx pm2 logs tickr-main --lines 80 --nostream
npx pm2 logs tickr-contract --lines 80 --nostream
```

## Update deployment
```bash
bash deploy/update-ubuntu.sh /opt/tickr-alerts main
```

## Common checks
- Main monitor should print `Outgoing-only mode: on`.
- Contract monitor should print `Threshold: off`.
- If Telegram is silent, run:
```bash
cd /opt/tickr-alerts
node index.js --smoke --telegram-test
npm run contract-monitor -- --smoke
```
