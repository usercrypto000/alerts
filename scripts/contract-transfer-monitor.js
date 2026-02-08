import 'dotenv/config';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ethers } from 'ethers';

// Ethers v6 needs a WebSocket implementation in Node.
globalThis.WebSocket = WebSocket;

const DEFAULT_CONTRACTS = [
  '0xA27EC0006e59f245217Ff08CD52A7E8b169E62D2',
  '0x449a917fb4910cb2f57335D619e71674fFB8BC44'
];

function parseContractList() {
  const env = String(process.env.CONTRACT_ADDRESSES || '').trim();
  const raw = env
    ? env
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_CONTRACTS;

  const normalized = [];
  for (const a of raw) {
    try {
      normalized.push(ethers.getAddress(a));
    } catch {
      // ignore
    }
  }

  // de-dupe by lowercase
  return [...new Set(normalized.map((a) => a.toLowerCase()))].map((a) => ethers.getAddress(a));
}

const CONTRACTS = parseContractList();
const CONTRACTS_LOWER = new Set(CONTRACTS.map((a) => a.toLowerCase()));

const MIN_USD = Number(process.env.CONTRACT_MIN_USD ?? process.env.MIN_USD ?? 0);
const PRICE_CACHE_MS = Number(process.env.PRICE_CACHE_MS ?? 60_000);
const BAL_CACHE_MS = Number(process.env.BAL_CACHE_MS ?? 120_000);

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim() || null;
const ETHERSCAN_BASE_URL = (process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/v2/api').trim();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

function getArgFlag(argv, name) {
  return argv.includes(name);
}
function getArgValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortAddr(addr) {
  try {
    const a = ethers.getAddress(addr);
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
  } catch {
    return String(addr || '');
  }
}

function formatUsd(usd) {
  if (usd == null || !Number.isFinite(usd)) return 'n/a';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtLink(href, text) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(html) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
  if (!CHAT_ID) throw new Error('Missing CHAT_ID (or TELEGRAM_CHAT_ID) in .env');
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  const res = await fetchWithTimeout(
    url,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    12_000
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Telegram error: ${res.status} ${t}`.trim());
  }
}

function buildAlchemyWsUrl(apiKey) {
  const net = (process.env.ALCHEMY_NETWORK || 'eth-mainnet').trim();
  const key = String(apiKey || '').trim();
  if (!key) return null;
  return `wss://${net}.g.alchemy.com/v2/${key}`;
}

function buildAlchemyHttpUrl(apiKey) {
  const net = (process.env.ALCHEMY_NETWORK || 'eth-mainnet').trim();
  const key = String(apiKey || '').trim();
  if (!key) return null;
  return `https://${net}.g.alchemy.com/v2/${key}`;
}

function buildInfuraWsUrl(projectId) {
  const net = (process.env.INFURA_NETWORK || 'mainnet').trim();
  const id = String(projectId || '').trim();
  if (!id) return null;
  return `wss://${net}.infura.io/ws/v3/${id}`;
}

function buildInfuraHttpUrl(projectId) {
  const net = (process.env.INFURA_NETWORK || 'mainnet').trim();
  const id = String(projectId || '').trim();
  if (!id) return null;
  return `https://${net}.infura.io/v3/${id}`;
}

const WS_URL =
  process.env.ALCHEMY_WS_URL ||
  buildAlchemyWsUrl(process.env.ALCHEMY_API_KEY) ||
  process.env.INFURA_WS_URL ||
  buildInfuraWsUrl(process.env.INFURA_PROJECT_ID) ||
  process.env.ETH_WS_URL ||
  process.env.WS_URL ||
  process.env.ETHEREUM_WS_URL;

const RPC_URL =
  process.env.ALCHEMY_HTTPS_URL ||
  buildAlchemyHttpUrl(process.env.ALCHEMY_API_KEY) ||
  process.env.INFURA_HTTPS_URL ||
  buildInfuraHttpUrl(process.env.INFURA_PROJECT_ID) ||
  process.env.ETH_RPC_URL ||
  process.env.RPC_URL ||
  process.env.ETHEREUM_RPC_URL;

const tokenInfoCache = new Map(); // tokenLower -> { symbol, decimals }
const tokenPriceCache = new Map(); // tokenLower -> { usd, ts }
let ethPriceCache = { usd: null, ts: 0 };

const balanceCache = new Map(); // addrLower -> { eth, ts }

const funderCache = new Map(); // addrLower -> { funderLower|null, ts }
const funderSeenCounts = new Map(); // funderLower -> count
const funderToWallets = new Map(); // funderLower -> Set(walletLower)

function makeEtherscanUrl(chainId) {
  const url = new URL(ETHERSCAN_BASE_URL);
  if (url.pathname.includes('/v2/') && chainId != null) url.searchParams.set('chainid', String(chainId));
  return url;
}

async function getEthUsd() {
  const now = Date.now();
  if (ethPriceCache.usd && now - ethPriceCache.ts < PRICE_CACHE_MS) return ethPriceCache.usd;
  const forced = Number(process.env.ETH_USD);
  if (Number.isFinite(forced) && forced > 0) {
    ethPriceCache = { usd: forced, ts: now };
    return forced;
  }
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
  const res = await fetchWithTimeout(url, {}, 12_000);
  if (!res.ok) return ethPriceCache.usd;
  const json = await res.json().catch(() => ({}));
  const usd = Number(json?.ethereum?.usd);
  if (Number.isFinite(usd) && usd > 0) ethPriceCache = { usd, ts: now };
  return ethPriceCache.usd;
}

function passesUsdThreshold(usd) {
  if (!(MIN_USD > 0)) return true;
  return usd != null && Number.isFinite(usd) && usd > MIN_USD;
}

async function getTokenInfo(provider, token) {
  const tokenLower = token.toLowerCase();
  const cached = tokenInfoCache.get(tokenLower);
  if (cached) return cached;
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const out = { symbol: String(symbol), decimals: Number(decimals) };
  tokenInfoCache.set(tokenLower, out);
  return out;
}

async function getTokenUsd(token) {
  const tokenLower = token.toLowerCase();
  const now = Date.now();
  const cached = tokenPriceCache.get(tokenLower);
  if (cached && now - cached.ts < PRICE_CACHE_MS) return cached.usd;
  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${tokenLower}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url, {}, 12_000);
  if (!res.ok) {
    tokenPriceCache.set(tokenLower, { usd: null, ts: now });
    return null;
  }
  const json = await res.json().catch(() => ({}));
  const usd = Number(json?.[tokenLower]?.usd);
  const out = Number.isFinite(usd) && usd > 0 ? usd : null;
  tokenPriceCache.set(tokenLower, { usd: out, ts: now });
  return out;
}

async function getBalanceEth(provider, addr) {
  const a = ethers.getAddress(addr).toLowerCase();
  const now = Date.now();
  const cached = balanceCache.get(a);
  if (cached && now - cached.ts < BAL_CACHE_MS) return cached.eth;
  const bal = await provider.getBalance(addr);
  const eth = Number(ethers.formatEther(bal));
  balanceCache.set(a, { eth, ts: now });
  return eth;
}

function looksLikeWhaleLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return false;
  return s.includes('whale') || s.includes('eth whale');
}

async function getFunder(provider, chainId, addr) {
  const a = ethers.getAddress(addr).toLowerCase();
  const now = Date.now();
  const cached = funderCache.get(a);
  if (cached && now - cached.ts < 24 * 60 * 60 * 1000) return cached.funderLower;
  if (!ETHERSCAN_API_KEY || chainId !== 1n) {
    funderCache.set(a, { funderLower: null, ts: now });
    return null;
  }
  const url = makeEtherscanUrl(Number(chainId));
  url.searchParams.set('module', 'account');
  url.searchParams.set('action', 'txlist');
  url.searchParams.set('address', addr);
  url.searchParams.set('sort', 'asc');
  url.searchParams.set('page', '1');
  url.searchParams.set('offset', '25');
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);

  const res = await fetchWithTimeout(url.toString(), {}, 12_000);
  if (!res.ok) {
    funderCache.set(a, { funderLower: null, ts: now });
    return null;
  }
  const json = await res.json().catch(() => null);
  const result = Array.isArray(json?.result) ? json.result : [];
  const firstIncoming = result.find((t) => String(t?.to || '').toLowerCase() === a && String(t?.from || '').startsWith('0x'));
  const funder = firstIncoming?.from ? String(firstIncoming.from) : null;
  const funderLower = funder ? ethers.getAddress(funder).toLowerCase() : null;
  funderCache.set(a, { funderLower, ts: now });
  return funderLower;
}

async function classifyCounterparty(provider, chainId, counterparty, knownLabelMaybe) {
  const addr = ethers.getAddress(counterparty);
  const addrLower = addr.toLowerCase();

  if (looksLikeWhaleLabel(knownLabelMaybe)) return 'whale';

  const balEth = await getBalanceEth(provider, addr).catch(() => null);
  if (balEth != null && balEth > 1000) return 'whale';

  const funderLower = await getFunder(provider, chainId, addr).catch(() => null);
  if (funderLower) {
    if (!funderToWallets.has(funderLower)) funderToWallets.set(funderLower, new Set());
    const set = funderToWallets.get(funderLower);
    const before = set.size;
    set.add(addrLower);
    if (set.size !== before) funderSeenCounts.set(funderLower, (funderSeenCounts.get(funderLower) || 0) + 1);
    const count = funderSeenCounts.get(funderLower) || 0;
    if (count >= 3) return 'sybil_suspect';
  }

  return 'unknown';
}

function decodeTransferLog(log) {
  // topics: [sig, from, to]; data: value
  if (!log?.topics || log.topics.length !== 3) return null;
  const from = ethers.getAddress(`0x${log.topics[1].slice(-40)}`);
  const to = ethers.getAddress(`0x${log.topics[2].slice(-40)}`);
  const amount = ethers.getBigInt(log.data);
  return { from, to, amount };
}

async function tryAlchemyAssetTransfers(provider, fromBlock, toBlock, contractAddress) {
  // Optional: if you're on Alchemy, use their transfer indexer to also catch internal ETH sends.
  // This is still "ethers.js" (JSON-RPC), but not all providers support it.
  const payload = {
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(toBlock),
    category: ['external', 'internal', 'erc20'],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: '0x3e8',
    fromAddress: contractAddress
  };
  const payloadIn = { ...payload, fromAddress: undefined, toAddress: contractAddress };
  const [out, inn] = await Promise.all([
    provider.send('alchemy_getAssetTransfers', [payload]).catch(() => null),
    provider.send('alchemy_getAssetTransfers', [payloadIn]).catch(() => null)
  ]);
  const transfers = [...(out?.transfers || []), ...(inn?.transfers || [])];
  return transfers;
}

async function alertTransfer({ provider, network, kind, contract, from, to, token, amountText, usd, counterparty, counterpartyClass }) {
  const explorer = network.chainId === 1n ? 'https://etherscan.io' : null;
  const txHref = kind?.txHash && explorer ? `${explorer}/tx/${kind.txHash}` : null;

  const title = `<b>Contract transfer</b>`;
  const lines = [];
  if (contract) lines.push(`<b>CONTRACT</b>: <code>${escapeHtml(contract)}</code>`);
  lines.push(`<b>FROM</b>: <code>${escapeHtml(from)}</code>`);
  lines.push(`<b>TO</b>: <code>${escapeHtml(to)}</code>`);
  lines.push(`<b>TOKEN</b>: <b>${escapeHtml(token)}</b>`);
  lines.push(`<b>AMOUNT</b>: <code>${escapeHtml(amountText)}</code>`);
  lines.push(`<b>USD</b>: <b>${escapeHtml(formatUsd(usd))}</b>`);
  lines.push(`<b>COUNTERPARTY</b>: <code>${escapeHtml(counterparty)}</code> (<b>${escapeHtml(counterpartyClass)}</b>)`);
  if (txHref) lines.push(`<b>TX</b>: ${fmtLink(txHref, 'Etherscan')}`);

  const msg = [title, '', ...lines].join('\n');
  await sendTelegram(msg);
}

async function processBlock(provider, network, blockNumber, knownLabels = new Map()) {
  const alertDedup = new Set(); // per-block best-effort
  const topicsForContracts = CONTRACTS.map((a) => ethers.zeroPadValue(a, 32));

  const logs = (
    await Promise.all(
      topicsForContracts.flatMap((contractTopic) => [
        provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics: [TOPIC_TRANSFER, contractTopic, null] }).catch(() => []),
        provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics: [TOPIC_TRANSFER, null, contractTopic] }).catch(() => [])
      ])
    )
  ).flat();

  const seen = new Set();
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const decoded = decodeTransferLog(log);
    if (!decoded) continue;

    const { from, to, amount } = decoded;
    const fromIsContract = CONTRACTS_LOWER.has(from.toLowerCase());
    const toIsContract = CONTRACTS_LOWER.has(to.toLowerCase());
    if (!fromIsContract && !toIsContract) continue;
    const contract = fromIsContract ? from : to;
    const tokenAddr = ethers.getAddress(log.address);
    const tokenLower = tokenAddr.toLowerCase();

    const [info, px] = await Promise.all([
      getTokenInfo(provider, tokenAddr).catch(() => null),
      getTokenUsd(tokenAddr).catch(() => null)
    ]);
    if (!info) continue;

    const qty = Number(ethers.formatUnits(amount, info.decimals));
    const usd = px ? qty * px : null;
    if (!passesUsdThreshold(usd)) continue;

    const counterparty = fromIsContract ? to : from;
    const counterpartyLabel = knownLabels.get(counterparty.toLowerCase()) || null;
    const counterpartyClass = await classifyCounterparty(provider, network.chainId, counterparty, counterpartyLabel);

    const dedupKey = `erc20:${log.transactionHash}:${tokenLower}:${from.toLowerCase()}:${to.toLowerCase()}:${amount.toString()}`;
    if (alertDedup.has(dedupKey)) continue;
    alertDedup.add(dedupKey);

    await alertTransfer({
      provider,
      network,
      kind: { txHash: log.transactionHash },
      contract,
      from,
      to,
      token: info.symbol || 'TOKEN',
      amountText: `${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${info.symbol || ''}`.trim(),
      usd,
      counterparty,
      counterpartyClass
    });
  }

  // ETH incoming transfers to the contract (outgoing internal sends require trace/indexer support).
  const block = await provider.getBlock(blockNumber, true).catch(() => null);
  for (const tx of block?.transactions || []) {
    if (!tx?.to) continue;
    const toAddr = ethers.getAddress(tx.to);
    if (!CONTRACTS_LOWER.has(toAddr.toLowerCase())) continue;
    const value = tx.value ?? 0n;
    if (value <= 0n) continue;
    const ethUsd = await getEthUsd().catch(() => null);
    const eth = Number(ethers.formatEther(value));
    const usd = ethUsd ? eth * ethUsd : null;
    if (!passesUsdThreshold(usd)) continue;

    const from = ethers.getAddress(tx.from);
    const to = toAddr;
    const contract = toAddr;
    const counterparty = from;
    const counterpartyLabel = knownLabels.get(counterparty.toLowerCase()) || null;
    const counterpartyClass = await classifyCounterparty(provider, network.chainId, counterparty, counterpartyLabel);

    const dedupKey = `eth_in:${tx.hash}:${from.toLowerCase()}:${to.toLowerCase()}:${value.toString()}`;
    if (alertDedup.has(dedupKey)) continue;
    alertDedup.add(dedupKey);

    await alertTransfer({
      provider,
      network,
      kind: { txHash: tx.hash },
      contract,
      from,
      to,
      token: 'ETH',
      amountText: `${eth.toFixed(6)} ETH`,
      usd,
      counterparty,
      counterpartyClass
    });
  }

  // Optional: Alchemy indexer for internal ETH/outgoing. Best-effort and only if supported.
  const canAlchemy = (WS_URL || RPC_URL || '').includes('alchemy.com');
  if (canAlchemy) {
    const transfers = (
      await Promise.all(CONTRACTS.map((addr) => tryAlchemyAssetTransfers(provider, blockNumber, blockNumber, addr).catch(() => [])))
    ).flat();
    for (const t of transfers || []) {
      const category = String(t.category || '').toLowerCase();
      const asset = String(t.asset || '').toUpperCase();
      const from = t.from ? ethers.getAddress(t.from) : null;
      const to = t.to ? ethers.getAddress(t.to) : null;
      if (!from || !to) continue;
      const fromIsContract = CONTRACTS_LOWER.has(from.toLowerCase());
      const toIsContract = CONTRACTS_LOWER.has(to.toLowerCase());
      if (!fromIsContract && !toIsContract) continue;
      const contract = fromIsContract ? from : to;

      let computedUsd = null;
      let token = asset || 'TOKEN';
      let amountText = String(t.value ?? '');

      if (category === 'erc20' && t.rawContract?.address) {
        const tokenAddr = ethers.getAddress(t.rawContract.address);
        const [info, px] = await Promise.all([
          getTokenInfo(provider, tokenAddr).catch(() => null),
          getTokenUsd(tokenAddr).catch(() => null)
        ]);
        if (!info || !px) continue;
        token = info.symbol || token;
        const qty = Number(t.value);
        computedUsd = qty * px;
        amountText = `${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token}`.trim();
      } else if (asset === 'ETH') {
        const ethUsd = await getEthUsd().catch(() => null);
        if (!ethUsd) continue;
        const eth = Number(t.value);
        computedUsd = eth * ethUsd;
        amountText = `${eth.toFixed(6)} ETH`;
      } else {
        continue;
      }

      if (!passesUsdThreshold(computedUsd)) continue;

      const counterparty = fromIsContract ? to : from;
      const counterpartyLabel = knownLabels.get(counterparty.toLowerCase()) || null;
      const counterpartyClass = await classifyCounterparty(provider, network.chainId, counterparty, counterpartyLabel);

      const dedupKey = `alchemy:${String(t.hash || '')}:${String(t.uniqueId || '')}:${token}:${from.toLowerCase()}:${to.toLowerCase()}:${amountText}`;
      if (alertDedup.has(dedupKey)) continue;
      alertDedup.add(dedupKey);

      await alertTransfer({
        provider,
        network,
        kind: { txHash: t.hash || t.uniqueId || null },
        contract,
        from,
        to,
        token,
        amountText,
        usd: computedUsd,
        counterparty,
        counterpartyClass
      });
    }
  }
}

function loadKnownLabels() {
  // Reuse the repo's known labels if present.
  const labels = new Map();
  try {
    const known = JSON.parse(fs.readFileSync(new URL('../config/address-labels.json', import.meta.url), 'utf8'));
    for (const [addr, label] of Object.entries(known || {})) {
      try {
        labels.set(ethers.getAddress(addr).toLowerCase(), String(label));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return labels;
}

async function main() {
  const argv = process.argv.slice(2);
  const validate = getArgFlag(argv, '--validate');
  const smoke = getArgFlag(argv, '--smoke');
  const httpOnly = getArgFlag(argv, '--http');
  const pollMs = Number(getArgValue(argv, '--poll-ms') ?? process.env.HTTP_POLL_MS ?? 4000);

  if (!WS_URL && !RPC_URL) {
    throw new Error('Missing provider URL. Set ALCHEMY_API_KEY (recommended) or ALCHEMY_WS_URL / ALCHEMY_HTTPS_URL (or Infura equivalents).');
  }

  if (validate) {
    console.log('contract-transfer-monitor validate OK');
    console.log(`CONTRACTS: ${CONTRACTS.join(', ')}`);
    console.log(`MIN_USD: ${MIN_USD > 0 ? MIN_USD : 'off'}`);
    console.log(`WS_URL: ${WS_URL ? 'set' : 'missing'}`);
    console.log(`RPC_URL: ${RPC_URL ? 'set' : 'missing'}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN ? 'set' : 'missing'} / chat_id: ${CHAT_ID ? 'set' : 'missing'}`);
    console.log(`Etherscan key: ${ETHERSCAN_API_KEY ? 'set' : 'missing'}`);
    return;
  }

  const knownLabels = loadKnownLabels();
  const provider =
    !httpOnly && WS_URL ? new ethers.WebSocketProvider(WS_URL) : new ethers.JsonRpcProvider(RPC_URL || WS_URL);
  const network = await provider.getNetwork();
  console.log(`Connected: chainId=${network.chainId.toString()} name=${network.name}`);
  console.log(`Monitoring contracts: ${CONTRACTS.join(', ')}`);
  console.log(`Threshold: ${MIN_USD > 0 ? `>${MIN_USD} USD` : 'off'}`);

  const latest = await provider.getBlockNumber();
  console.log(`Latest block: ${latest}`);

  if (smoke) {
    await sendTelegram(
      `<b>contract-transfer-monitor</b>\n\nCONTRACTS: <code>${escapeHtml(CONTRACTS.join(', '))}</code>\nMIN_USD: <b>${escapeHtml(MIN_USD > 0 ? String(MIN_USD) : 'off')}</b>`
    );
    console.log('Telegram: sent test message');
    try {
      provider.destroy();
    } catch {
      // ignore
    }
    return;
  }

  if (!httpOnly && provider instanceof ethers.WebSocketProvider) {
    provider.on('block', (bn) => {
      processBlock(provider, network, bn, knownLabels).catch((e) => console.error('block failed:', e?.message || e));
    });
    provider.on('error', (e) => console.error('provider error:', e?.message || e));
    return;
  }

  // HTTP polling mode
  let last = latest;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const bn = await provider.getBlockNumber().catch(() => null);
    if (bn != null && bn > last) {
      for (let b = last + 1; b <= bn; b++) {
        await processBlock(provider, network, b, knownLabels).catch((e) => console.error('block failed:', e?.message || e));
      }
      last = bn;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exitCode = 1;
});
