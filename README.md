# tiCkr alerts (Ethereum -> Telegram)

Monitors configured wallets and sends Telegram alerts for:
- ETH and ERC20 transfers
- Bridge transactions (known bridge contracts)
- ERC721 / ERC1155 mint events
- New contract deployments by monitored wallets
- Contract interactions when target contracts are newly deployed (default: 30 days)

## Setup

1) Install dependencies:
```powershell
npm i
```

2) Copy `.env.example` to `.env` and set required values:
- `TELEGRAM_BOT_TOKEN`
- `CHAT_ID` (or `TELEGRAM_CHAT_ID`)
- provider endpoint:
  - `RPC_URL` (recommended for cron), or
  - `ALCHEMY_API_KEY`, or
  - explicit WS/HTTP provider URLs

3) Set monitored addresses:
- `config/addresses.json`

Optional config:
- `config/known-contracts.json`
- `config/bridge-contracts.json`
- `config/address-labels.json`
- `config/address-labels-unknown.json`

## Run modes

Continuous mode (local):
```powershell
npm start
```

Cron-safe once mode:
```powershell
npm run alerts:once
```

Once mode behavior:
- Loads state from `STATE_FILE` (default `state.json`)
- Processes `lastProcessedBlock + 1` to latest block
- Caps each run with `MAX_BLOCKS_PER_RUN`
- Persists updated state back to file
- Uses dedupe keys (`recentAlertKeys`) to avoid duplicate alerts

## Useful commands

Validate env/config:
```powershell
node index.js --validate
```

Smoke test:
```powershell
node index.js --smoke
```

Process one tx:
```powershell
node index.js --http --tx 0xYOUR_TX_HASH --dry-run
```

## GitHub Actions (no VPS / no PM2)

Workflow:
- `.github/workflows/alerts.yml`

It:
- Runs on schedule + manual trigger
- Executes `npm run alerts:once`
- Commits updated `state.json` when changed

Required GitHub secrets:
- `TELEGRAM_BOT_TOKEN`
- `CHAT_ID`
- `RPC_URL` (or `ALCHEMY_API_KEY`)
- optional `ETHERSCAN_API_KEY`

Optional GitHub repo variables:
- `MAX_BLOCKS_PER_RUN`
- `MAX_RECENT_ALERT_KEYS`
- `STATE_BOOTSTRAP_LATEST`

## Notes

- For unstable WS providers, use HTTP mode (`--http`) or `RPC_URL`.
- `STATE_BOOTSTRAP_LATEST=1` initializes first run near latest block to avoid large backfills.
- `ETH_USD` can be set to a fixed value as fallback if CoinGecko is unavailable.
