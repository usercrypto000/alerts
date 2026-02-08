import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ethers } from 'ethers';

// Ethers v6 needs a WebSocket implementation in Node.
globalThis.WebSocket = WebSocket;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ETHERSCAN_API_KEY = (process.env.ETHERSCAN_API_KEY || '').trim() || null;
const ETHERSCAN_BASE_URL = (process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/v2/api').trim();
const etherscanCacheFile = path.join(__dirname, 'data', 'etherscan-cache.json');
const etherscanCreationCacheFile = path.join(__dirname, 'data', 'etherscan-contract-creation.json');

const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');
const TOPIC_APPROVAL = ethers.id('Approval(address,address,uint256)');
const TOPIC_APPROVAL_FOR_ALL = ethers.id('ApprovalForAll(address,address,bool)');
const TOPIC_ERC1155_SINGLE = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_ERC1155_BATCH = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

const ERC721_ABI = ['function name() view returns (string)'];

const APPROVAL_SELECTORS = new Set([
  '0x095ea7b3', // approve(address,uint256)
  '0xa22cb465', // setApprovalForAll(address,bool)
  '0xd505accf', // permit(address,address,uint256,uint256,uint8,bytes32,bytes32) (EIP-2612 common)
  '0x39509351', // increaseAllowance(address,uint256)
  '0xa457c2d7' // decreaseAllowance(address,uint256)
]);

const SWAP_SELECTORS = new Set([
  '0x38ed1739', // swapExactTokensForTokens
  '0x18cbafe5', // swapExactETHForTokens
  '0x7ff36ab5', // swapExactETHForTokensSupportingFeeOnTransferTokens
  '0x8803dbee', // swapTokensForExactTokens
  '0xfb3bdb41', // swapETHForExactTokens
  '0x4a25d94a', // swapTokensForExactETH
  '0x5c11d795', // swapExactTokensForETHSupportingFeeOnTransferTokens
  '0xb6f9de95', // swapExactTokensForETH
  '0x414bf389', // exactInputSingle
  '0xc04b8d59', // exactInput
  '0xdb3e2198', // exactOutputSingle
  '0xf28c0498', // exactOutput
  '0x12aa3caf', // 1inch swap
  '0x0502b1c5', // 1inch unoswap
  '0x2e95b6c8' // 1inch unoswapTo
]);

function readJson(relPath, fallback) {
  try {
    const fullPath = path.join(__dirname, relPath);
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDirSync(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
}

function getMethodId(data) {
  if (!data || typeof data !== 'string') return null;
  const d = data.toLowerCase();
  if (d === '0x' || d.length < 10) return null;
  return d.slice(0, 10);
}

function makeEtherscanUrl(network) {
  const url = new URL(ETHERSCAN_BASE_URL);
  // Etherscan API v2 uses /v2/api and requires chainid.
  if (url.pathname.includes('/v2/') && network?.chainId != null) {
    url.searchParams.set('chainid', network.chainId.toString());
  }
  return url;
}

const settings = readJson('config/settings.json', {});
function numberFromEnv(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const minUsd = numberFromEnv(process.env.MIN_USD) ?? Number(settings.minUsd ?? 50000);
const minBridgeUsd = numberFromEnv(process.env.MIN_BRIDGE_USD) ?? Number(settings.minBridgeUsd ?? 20000);
const alwaysAlertAll = String(process.env.ALWAYS_ALERT_ALL ?? settings.alwaysAlertAll ?? '').trim() === '1';
const outgoingOnly = String(process.env.OUTGOING_ONLY ?? settings.outgoingOnly ?? '1').trim() === '1';
const maxBlocksPerRun = numberFromEnv(process.env.MAX_BLOCKS_PER_RUN) ?? Number(settings.maxBlocksPerRun ?? 200);
const maxRecentAlertKeys = numberFromEnv(process.env.MAX_RECENT_ALERT_KEYS) ?? Number(settings.maxRecentAlertKeys ?? 5000);
const stateBootstrapLatest = String(process.env.STATE_BOOTSTRAP_LATEST ?? settings.stateBootstrapLatest ?? '1').trim() === '1';
const defaultStateFile = (process.env.STATE_FILE ?? settings.stateFile ?? 'state.json').trim();
const priceCacheMs = Number(settings.priceCacheMs ?? 300000);
const ethPriceCacheMs = Number(settings.ethPriceCacheMs ?? 60000);
const maxTxsPerBlock = Number(settings.maxTxsPerBlock ?? 2500);
const maxConcurrentReceipts = Number(settings.maxConcurrentReceipts ?? 6);
const contractLabelCacheTtlMs = Number(settings.contractLabelCacheTtlMs ?? 7 * 24 * 60 * 60 * 1000);
const heartbeatMinutes = numberFromEnv(process.env.HEARTBEAT_MINUTES) ?? Number(settings.heartbeatMinutes ?? 0);
const startupPing = String(process.env.STARTUP_PING ?? settings.startupPing ?? '').trim() === '1';
const alertAllTx = String(process.env.ALERT_ALL_TX ?? settings.alertAllTx ?? '').trim() === '1';
const debug = String(process.env.DEBUG ?? settings.debug ?? '').trim() === '1';
const newContractDays = numberFromEnv(process.env.NEW_CONTRACT_DAYS) ?? Number(settings.newContractDays ?? 30);

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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

if (!WS_URL && !RPC_URL) {
  throw new Error(
    'Missing provider URL. Set ALCHEMY_API_KEY (recommended) or ALCHEMY_WS_URL / ALCHEMY_HTTPS_URL (or Infura equivalents).'
  );
}
if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!CHAT_ID) throw new Error('Missing CHAT_ID (or TELEGRAM_CHAT_ID) in .env');

const monitoredConfig = readJson('config/addresses.json', []);
let monitoredList = null;
if (Array.isArray(monitoredConfig)) {
  monitoredList = monitoredConfig;
} else if (monitoredConfig && typeof monitoredConfig === 'object') {
  // Supports: { labeled: [...], unknown: [...]} or { addresses: [...] }
  monitoredList = [
    ...(Array.isArray(monitoredConfig.labeled) ? monitoredConfig.labeled : []),
    ...(Array.isArray(monitoredConfig.unknown) ? monitoredConfig.unknown : []),
    ...(Array.isArray(monitoredConfig.addresses) ? monitoredConfig.addresses : [])
  ];
} else {
  monitoredList = [];
}

if (!Array.isArray(monitoredList) || monitoredList.length === 0) {
  throw new Error('config/addresses.json must contain addresses (array or {labeled/unknown})');
}

function parseMonitoredEntry(entry) {
  if (typeof entry === 'string') return { address: entry, label: null };
  if (entry && typeof entry === 'object') {
    const address = entry.address || entry.addr || entry.wallet || null;
    const label = typeof entry.label === 'string' ? entry.label.trim() : null;
    const role = typeof entry.role === 'string' ? entry.role.trim() : null;
    const description = typeof entry.description === 'string' ? entry.description.trim() : null;
    const alwaysAlert = String(entry.alwaysAlert ?? entry.always_alert ?? entry.trackAll ?? '').trim() === '1' || entry.alwaysAlert === true || entry.trackAll === true;
    if (typeof address === 'string') return { address, label: label || null, role: role || null, description: description || null, alwaysAlert };
  }
  return null;
}

const monitoredEntries = monitoredList.map(parseMonitoredEntry).filter(Boolean);
if (monitoredEntries.length === 0) {
  throw new Error('config/addresses.json did not contain any valid address entries');
}

const monitored = new Set(monitoredEntries.map((e) => ethers.getAddress(e.address).toLowerCase()));
const monitoredTopics = [...monitored].map((a) => ethers.zeroPadValue(a, 32));

// Labels embedded next to addresses in config/addresses.json
const configuredAddressLabels = new Map(); // addressLower -> label (non-UNKNOWN)
const configuredUnknownPlaceholders = new Set(); // addressLower where label is "UNKNOWN"
const configuredAddressDescriptions = new Map(); // addressLower -> description
const configuredAddressRoles = new Map(); // addressLower -> role
const configuredAlwaysAlert = new Set(); // addressLower -> always alert regardless of thresholds/filters
for (const e of monitoredEntries) {
  try {
    const addr = ethers.getAddress(e.address).toLowerCase();
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!label) continue;
    if (label.toUpperCase() === 'UNKNOWN') configuredUnknownPlaceholders.add(addr);
    else configuredAddressLabels.set(addr, label);
    const role = typeof e.role === 'string' ? e.role.trim() : '';
    if (role) configuredAddressRoles.set(addr, role);
    const desc = typeof e.description === 'string' ? e.description.trim() : '';
    if (desc) configuredAddressDescriptions.set(addr, desc);
    if (e.alwaysAlert) configuredAlwaysAlert.add(addr);
  } catch {
    // ignore
  }
}

const addressLabelsKnownRaw = readJson('config/address-labels.json', {});
const addressLabelsUnknownRaw = readJson('config/address-labels-unknown.json', {});

const addressLabels = new Map(); // addressLower -> label
const addressUnknownPlaceholders = new Set(); // addresses with label placeholder "UNKNOWN"

for (const [addr, label] of Object.entries(addressLabelsKnownRaw)) {
  try {
    const a = ethers.getAddress(addr).toLowerCase();
    const l = typeof label === 'string' ? label.trim() : '';
    if (!l) continue;
    addressLabels.set(a, l);
  } catch {
    // ignore
  }
}

for (const [addr, label] of Object.entries(addressLabelsUnknownRaw)) {
  try {
    const a = ethers.getAddress(addr).toLowerCase();
    const l = typeof label === 'string' ? label.trim() : '';
    if (l.toUpperCase() === 'UNKNOWN') addressUnknownPlaceholders.add(a);
  } catch {
    // ignore
  }
}

const knownContractsRaw = readJson('config/known-contracts.json', {});
const knownContracts = new Map(
  Object.entries(knownContractsRaw).map(([name, addr]) => [ethers.getAddress(addr).toLowerCase(), name])
);

const bridgeContractsRaw = readJson('config/bridge-contracts.json', {});
const bridgeContracts = new Map(); // addressLower -> label|null

function isLikelyAddressString(s) {
  return typeof s === 'string' && s.startsWith('0x') && s.length === 42;
}

// Supports either:
// - { "Stargate Router": "0x..." } (label -> address)
// - { "0x...": "Stargate Router" } (address -> label)
if (bridgeContractsRaw && typeof bridgeContractsRaw === 'object' && !Array.isArray(bridgeContractsRaw)) {
  const entries = Object.entries(bridgeContractsRaw);
  const looksLikeAddrKey = entries.some(([k]) => isLikelyAddressString(k));
  if (looksLikeAddrKey) {
    for (const [addr, label] of entries) {
      try {
        const a = ethers.getAddress(addr).toLowerCase();
        const l = typeof label === 'string' ? label.trim() : '';
        bridgeContracts.set(a, l || null);
      } catch {
        // ignore
      }
    }
  } else {
    for (const [label, addr] of entries) {
      try {
        const a = ethers.getAddress(addr).toLowerCase();
        const l = typeof label === 'string' ? label.trim() : '';
        bridgeContracts.set(a, l || null);
      } catch {
        // ignore
      }
    }
  }
}

// Seed from known contracts (LayerZero/Stargate) so bridging works out-of-the-box.
for (const [addrLower, name] of knownContracts.entries()) {
  const n = String(name || '');
  if (!n) continue;
  if (n.toLowerCase().includes('layerzero') || n.toLowerCase().includes('stargate')) {
    if (!bridgeContracts.has(addrLower)) bridgeContracts.set(addrLower, n);
  }
}

let provider = null;
let preferHttpProvider = false;

const tokenInfoCache = new Map(); // addressLower -> { symbol, decimals }
const contractNameCache = new Map(); // addressLower -> string
const tokenPriceCache = new Map(); // addressLower -> { usd, ts }
let ethPriceCache = { usd: null, ts: 0 };
const codeIsContractCache = new Map(); // addressLower -> boolean
const ensNameCache = new Map(); // addressLower -> string|null

// Etherscan contract labels (persisted best-effort to disk)
const etherscanLabelCache = new Map(); // addressLower -> { label, ts }
const etherscanInFlight = new Map(); // addressLower -> Promise<label|null>
let pendingCacheWriteTimer = null;

// Etherscan contract creation (persisted best-effort to disk)
const etherscanCreationCache = new Map(); // addressLower -> { createdAtMs, createdBlock, createdTx, ts }
const etherscanCreationInFlight = new Map(); // addressLower -> Promise<entry|null>
let pendingCreationWriteTimer = null;

function loadEtherscanLabelCache() {
  const obj = readJson('data/etherscan-cache.json', null);
  if (!obj || typeof obj !== 'object') return;
  for (const [addr, entry] of Object.entries(obj)) {
    if (!addr || !entry) continue;
    const label = typeof entry.label === 'string' ? entry.label : null;
    const ts = Number(entry.ts);
    if (!label || !Number.isFinite(ts)) continue;
    etherscanLabelCache.set(addr.toLowerCase(), { label, ts });
  }
}

function scheduleEtherscanCacheWrite() {
  if (pendingCacheWriteTimer) return;
  pendingCacheWriteTimer = setTimeout(() => {
    pendingCacheWriteTimer = null;
    try {
      const dir = path.dirname(etherscanCacheFile);
      ensureDirSync(dir);
      const out = {};
      for (const [addr, entry] of etherscanLabelCache.entries()) out[addr] = entry;
      fs.writeFileSync(etherscanCacheFile, JSON.stringify(out, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }, 1500);
}

function loadEtherscanCreationCache() {
  const obj = readJson('data/etherscan-contract-creation.json', null);
  if (!obj || typeof obj !== 'object') return;
  for (const [addr, entry] of Object.entries(obj)) {
    if (!addr || !entry) continue;
    const createdAtMs = Number(entry.createdAtMs);
    const createdBlock = entry.createdBlock != null ? Number(entry.createdBlock) : null;
    const createdTx = typeof entry.createdTx === 'string' ? entry.createdTx : null;
    const ts = Number(entry.ts);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) continue;
    if (!Number.isFinite(ts)) continue;
    etherscanCreationCache.set(addr.toLowerCase(), { createdAtMs, createdBlock, createdTx, ts });
  }
}

function scheduleEtherscanCreationCacheWrite() {
  if (pendingCreationWriteTimer) return;
  pendingCreationWriteTimer = setTimeout(() => {
    pendingCreationWriteTimer = null;
    try {
      const dir = path.dirname(etherscanCreationCacheFile);
      ensureDirSync(dir);
      const out = {};
      for (const [addr, entry] of etherscanCreationCache.entries()) out[addr] = entry;
      fs.writeFileSync(etherscanCreationCacheFile, JSON.stringify(out, null, 2), 'utf8');
    } catch {
      // ignore
    }
  }, 1500);
}

async function isContractAddress(address) {
  const addr = ethers.getAddress(address).toLowerCase();
  const cached = codeIsContractCache.get(addr);
  if (cached != null) return cached;
  const code = await provider.getCode(addr).catch(() => '0x');
  const isContract = typeof code === 'string' && code !== '0x';
  codeIsContractCache.set(addr, isContract);
  return isContract;
}

async function getEtherscanContractCreation(address, network) {
  if (!ETHERSCAN_API_KEY) return null;
  if (!network || network.chainId !== 1n) return null;
  if (!provider) return null;

  const addr = ethers.getAddress(address).toLowerCase();
  const now = Date.now();
  const cached = etherscanCreationCache.get(addr);
  if (cached && now - cached.ts < contractLabelCacheTtlMs) return cached;
  if (etherscanCreationInFlight.has(addr)) return etherscanCreationInFlight.get(addr);

  const p = (async () => {
    try {
      const url = makeEtherscanUrl(network);
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', 'getcontractcreation');
      url.searchParams.set('contractaddresses', addr);
      url.searchParams.set('apikey', ETHERSCAN_API_KEY);

      const res = await fetchWithTimeout(url.toString(), { headers: { accept: 'application/json' } }, 12_000);
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const row = Array.isArray(json?.result) ? json.result[0] : null;
      const txHash = typeof row?.txHash === 'string' && row.txHash.startsWith('0x') ? row.txHash : null;
      if (!txHash) return null;

      const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
      if (!receipt?.blockNumber) return null;
      const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
      if (!block?.timestamp) return null;

      const createdAtMs = Number(block.timestamp) * 1000;
      const entry = {
        createdAtMs,
        createdBlock: Number(receipt.blockNumber),
        createdTx: txHash,
        ts: now
      };
      etherscanCreationCache.set(addr, entry);
      scheduleEtherscanCreationCacheWrite();
      return entry;
    } catch {
      return null;
    } finally {
      etherscanCreationInFlight.delete(addr);
    }
  })();

  etherscanCreationInFlight.set(addr, p);
  return p;
}

async function getNewlyDeployedInfo(address, network) {
  if (!address) return null;
  if (!ETHERSCAN_API_KEY || !network || network.chainId !== 1n) return null;
  if (!(await isContractAddress(address))) return null;
  const entry = await getEtherscanContractCreation(address, network);
  if (!entry?.createdAtMs) return null;
  const maxAgeMs = Math.max(1, newContractDays) * 24 * 60 * 60 * 1000;
  const ageMs = Date.now() - entry.createdAtMs;
  if (ageMs < 0 || ageMs > maxAgeMs) return null;
  return entry;
}

async function getEtherscanContractLabel(address, network) {
  if (!ETHERSCAN_API_KEY) return null;
  if (!network || network.chainId !== 1n) return null; // Etherscan mainnet by default

  const addr = ethers.getAddress(address).toLowerCase();
  const now = Date.now();
  const cached = etherscanLabelCache.get(addr);
  if (cached && now - cached.ts < contractLabelCacheTtlMs) return cached.label;

  if (etherscanInFlight.has(addr)) return etherscanInFlight.get(addr);

  const p = (async () => {
    try {
      const url = makeEtherscanUrl(network);
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', 'getsourcecode');
      url.searchParams.set('address', addr);
      url.searchParams.set('apikey', ETHERSCAN_API_KEY);

      const res = await fetchWithTimeout(url.toString(), { headers: { accept: 'application/json' } }, 12_000);
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const row = Array.isArray(json?.result) ? json.result[0] : null;
      const label =
        (typeof row?.ContractName === 'string' && row.ContractName.trim() ? row.ContractName.trim() : null) ||
        (typeof row?.TokenName === 'string' && row.TokenName.trim() ? row.TokenName.trim() : null) ||
        null;

      if (label) {
        etherscanLabelCache.set(addr, { label, ts: now });
        scheduleEtherscanCacheWrite();
      } else {
        // cache negative result briefly to reduce spam
        etherscanLabelCache.set(addr, { label: null, ts: now });
      }
      return label;
    } catch {
      return null;
    } finally {
      etherscanInFlight.delete(addr);
    }
  })();

  etherscanInFlight.set(addr, p);
  return p;
}

const STABLECOINS = new Map([
  // Mainnet stables (1 USD approximation)
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { symbol: 'USDC', decimals: 6, usd: 1 }],
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', { symbol: 'USDT', decimals: 6, usd: 1 }],
  ['0x6b175474e89094c44da98b954eedeac495271d0f', { symbol: 'DAI', decimals: 18, usd: 1 }],
  ['0x853d955acef822db058eb8505911ed77f175b99e', { symbol: 'FRAX', decimals: 18, usd: 1 }],
  ['0x5f98805a4e8be255a32880fdec7f6728c6568ba0', { symbol: 'LUSD', decimals: 18, usd: 1 }]
]);
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();

function shortAddr(addr) {
  const a = ethers.getAddress(addr);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function shortAddrMaybe(v) {
  try {
    return shortAddr(v);
  } catch {
    return '';
  }
}

function topicToAddress(topic) {
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

function formatUsd(usd) {
  if (usd == null || Number.isNaN(usd)) return 'n/a';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatEth(bi) {
  return Number(ethers.formatEther(bi)).toFixed(4);
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    },
    12_000
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtAddr(a) {
  return `<code>${escapeHtml(a)}</code>`;
}

function fmtLink(href, text) {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

function joinNonEmpty(parts, sep = ' ') {
  return parts.filter((p) => p != null && String(p).trim() !== '').join(sep);
}

function fmtMaybeLabel(label) {
  return label ? `<b>${escapeHtml(label)}</b>` : null;
}

async function fmtAddrWithLabel(address, network) {
  const label = await getAddressLabelMaybe(address, network);
  return joinNonEmpty([fmtAddr(address), label ? `(${fmtMaybeLabel(label)})` : null]);
}

function resolveStateFilePath(filePathArg) {
  const chosen = String(filePathArg || defaultStateFile || 'state.json').trim();
  if (!chosen) return path.join(__dirname, 'state.json');
  if (path.isAbsolute(chosen)) return chosen;
  return path.join(__dirname, chosen);
}

function normalizeState(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const lastProcessedRaw = Number(parsed.lastProcessedBlock);
  const lastProcessedBlockValue =
    Number.isInteger(lastProcessedRaw) && lastProcessedRaw >= 0 ? lastProcessedRaw : null;
  const keysRaw = Array.isArray(parsed.recentAlertKeys) ? parsed.recentAlertKeys : [];
  const keys = [];
  const seen = new Set();
  for (const key of keysRaw) {
    const normalized = String(key || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(normalized);
  }
  if (keys.length > maxRecentAlertKeys) {
    keys.splice(0, keys.length - maxRecentAlertKeys);
  }
  return {
    lastProcessedBlock: lastProcessedBlockValue,
    recentAlertKeys: keys
  };
}

function loadStateFromFile(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return normalizeState({});
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return normalizeState(raw);
  } catch {
    return normalizeState({});
  }
}

function saveStateToFile(stateFile, state) {
  ensureDirSync(path.dirname(stateFile));
  const tmpFile = `${stateFile}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpFile, stateFile);
}

function normalizePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function getChainText(network) {
  const chainId = network?.chainId != null ? network.chainId.toString() : 'unknown';
  const chainName = typeof network?.name === 'string' && network.name ? network.name : 'unknown';
  return `${chainName} (${chainId})`;
}

function buildAlertDedupKey({ network, txHash, blockNumber, trackedWallet, actionType }) {
  const chainId = network?.chainId != null ? network.chainId.toString() : 'unknown';
  const hash = String(txHash || '').toLowerCase();
  const block = String(blockNumber ?? '');
  let wallet = '';
  try {
    wallet = trackedWallet ? ethers.getAddress(trackedWallet).toLowerCase() : '';
  } catch {
    wallet = String(trackedWallet || '').toLowerCase();
  }
  const action = String(actionType || 'EVENT').toUpperCase();
  return `${chainId}:${block}:${hash}:${wallet}:${action}`;
}

let lastAlertAt = 0;
let lastSeenBlock = 0;
let lastProcessedBlock = 0;
let heartbeatTimer = null;
let telegramEnabled = true;
let telegramDryRun = false;
let telegramSends = 0;
let alertsBuilt = 0;
let blocksProcessed = 0;
let candidatesTotal = 0;
let runStateFile = null;
let runState = null;
let recentAlertKeys = new Set();
let persistStateOnAlert = false;

function setRunStateContext(stateFile, state, persistAlerts) {
  runStateFile = stateFile || null;
  runState = state || null;
  recentAlertKeys = new Set(Array.isArray(state?.recentAlertKeys) ? state.recentAlertKeys : []);
  persistStateOnAlert = Boolean(persistAlerts);
}

function saveRunStateIfNeeded() {
  if (!runStateFile || !runState) return;
  saveStateToFile(runStateFile, runState);
}

function hasRecentAlertKey(key) {
  if (!key) return false;
  return recentAlertKeys.has(key);
}

function rememberAlertKey(key) {
  if (!key || hasRecentAlertKey(key)) return;
  recentAlertKeys.add(key);
  const keys = [...recentAlertKeys];
  if (keys.length > maxRecentAlertKeys) {
    keys.splice(0, keys.length - maxRecentAlertKeys);
    recentAlertKeys = new Set(keys);
  }
  if (!runState) return;
  runState.recentAlertKeys = [...recentAlertKeys];
  if (persistStateOnAlert) {
    saveRunStateIfNeeded();
  }
}

async function sendTelegramTracked(text) {
  lastAlertAt = Date.now();
  alertsBuilt += 1;
  if (!telegramEnabled) {
    if (telegramDryRun) console.log('[DRY_RUN] Telegram message built');
    return;
  }
  await sendTelegram(text);
  telegramSends += 1;
}

async function getEthUsd() {
  const fixed = Number(process.env.ETH_USD);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const now = Date.now();
  if (ethPriceCache.usd != null && now - ethPriceCache.ts < ethPriceCacheMs) return ethPriceCache.usd;
  const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {}, 12_000);
  if (!res.ok) throw new Error(`Coingecko ETH price failed: ${res.status}`);
  const json = await res.json();
  const usd = Number(json?.ethereum?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`Bad ETH USD price: ${safeJson(json)}`);
  ethPriceCache = { usd, ts: now };
  return usd;
}

async function getTokenInfo(tokenAddress) {
  const addr = ethers.getAddress(tokenAddress).toLowerCase();
  if (STABLECOINS.has(addr)) return STABLECOINS.get(addr);
  if (tokenInfoCache.has(addr)) return tokenInfoCache.get(addr);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
  const info = { symbol: String(symbol), decimals: Number(decimals) };
  tokenInfoCache.set(addr, info);
  return info;
}

async function getContractNameMaybe(address) {
  const addr = ethers.getAddress(address).toLowerCase();
  if (contractNameCache.has(addr)) return contractNameCache.get(addr);
  try {
    const c = new ethers.Contract(addr, ERC721_ABI, provider);
    const name = await c.name();
    if (typeof name === 'string' && name.trim()) {
      contractNameCache.set(addr, name.trim());
      return name.trim();
    }
  } catch {
    // ignore
  }
  contractNameCache.set(addr, null);
  return null;
}

async function getEnsNameMaybe(address, network) {
  if (!provider) return null;
  if (!network || network.chainId !== 1n) return null;
  const addr = ethers.getAddress(address).toLowerCase();
  if (ensNameCache.has(addr)) return ensNameCache.get(addr);
  try {
    const name = await provider.lookupAddress(addr);
    const out = typeof name === 'string' && name.trim() ? name.trim() : null;
    ensNameCache.set(addr, out);
    return out;
  } catch {
    ensNameCache.set(addr, null);
    return null;
  }
}

async function getAddressLabelMaybe(address, network) {
  if (!address) return null;
  const addr = ethers.getAddress(address).toLowerCase();

  const configured = configuredAddressLabels.get(addr);
  if (configured) return configured;

  const custom = addressLabels.get(addr);
  if (custom) return custom;

  const known = knownContracts.get(addr);
  if (known) return known;

  const stable = STABLECOINS.get(addr);
  if (stable?.symbol) return stable.symbol;

  const nftName = await getContractNameMaybe(addr);
  if (nftName) return nftName;

  const etherscan = await getEtherscanContractLabel(addr, network);
  if (etherscan) return etherscan;

  const ens = await getEnsNameMaybe(addr, network);
  if (ens) return ens;

  if (configuredUnknownPlaceholders.has(addr)) return 'UNKNOWN';
  if (addressUnknownPlaceholders.has(addr)) return 'UNKNOWN';
  return null;
}

function getWalletLabelMaybe(address) {
  if (!address) return null;
  try {
    const addr = ethers.getAddress(address).toLowerCase();
    const configured = configuredAddressLabels.get(addr);
    if (configured) return configured;
    if (configuredUnknownPlaceholders.has(addr)) return 'UNKNOWN';
    return addressLabels.get(addr) || (addressUnknownPlaceholders.has(addr) ? 'UNKNOWN' : null);
  } catch {
    return null;
  }
}

async function getTokenUsd(tokenAddress) {
  const addr = ethers.getAddress(tokenAddress).toLowerCase();
  if (addr === WETH) return getEthUsd();
  const stable = STABLECOINS.get(addr);
  if (stable?.usd) return stable.usd;

  const now = Date.now();
  const cached = tokenPriceCache.get(addr);
  if (cached && now - cached.ts < priceCacheMs) return cached.usd;

  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addr}&vs_currencies=usd`;
  const res = await fetchWithTimeout(url, {}, 12_000);
  if (!res.ok) {
    tokenPriceCache.set(addr, { usd: null, ts: now });
    return null;
  }
  const json = await res.json().catch(() => ({}));
  const usd = Number(json?.[addr]?.usd);
  const out = Number.isFinite(usd) && usd > 0 ? usd : null;
  tokenPriceCache.set(addr, { usd: out, ts: now });
  return out;
}

function isMonitored(addr) {
  try {
    return monitored.has(ethers.getAddress(addr).toLowerCase());
  } catch {
    return false;
  }
}

function isAlwaysAlertWallet(addr) {
  if (alwaysAlertAll) return true;
  try {
    return configuredAlwaysAlert.has(ethers.getAddress(addr).toLowerCase());
  } catch {
    return false;
  }
}

function getWalletDescriptionMaybe(addr) {
  if (!addr) return null;
  try {
    const a = ethers.getAddress(addr).toLowerCase();
    return configuredAddressDescriptions.get(a) || null;
  } catch {
    return null;
  }
}

function getWalletRoleMaybe(addr) {
  if (!addr) return null;
  try {
    const a = ethers.getAddress(addr).toLowerCase();
    return configuredAddressRoles.get(a) || null;
  } catch {
    return null;
  }
}

function isApprovalOnly(tx, receipt, actionsFound) {
  if (actionsFound) return false;
  const methodId = getMethodId(tx?.data);
  if (methodId && APPROVAL_SELECTORS.has(methodId)) return true;
  if (!receipt?.logs?.length) return false;
  for (const log of receipt.logs) {
    const t0 = log.topics?.[0];
    if (t0 === TOPIC_APPROVAL || t0 === TOPIC_APPROVAL_FOR_ALL) continue;
    return false;
  }
  return true; // only approval logs
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

async function handleTx(blockNumber, tx, receipt, network) {
  const from = tx.from ? ethers.getAddress(tx.from) : null;
  const to = tx.to ? ethers.getAddress(tx.to) : null;
  const fromMon = from && isMonitored(from);
  const toMon = to && isMonitored(to);
  const fromAlways = Boolean(fromMon && from && isAlwaysAlertWallet(from));
  const toLower = to ? to.toLowerCase() : null;
  const isBridgeTarget = Boolean(fromMon && toLower && bridgeContracts.has(toLower));
  let bestBridge = null; // { asset, token?, symbol, qty?, eth?, usd }

  const actions = [];
  const methodId = getMethodId(tx.data);
  const toKnownLabel = to ? knownContracts.get(to.toLowerCase()) || null : null;
  const isSwapProtocolTarget = toKnownLabel ? /(uniswap|curve|balancer|sushi|1inch|dodo|cow)/i.test(toKnownLabel) : false;

  // Contract deployment
  if (!fromAlways && !tx.to && fromMon && receipt?.contractAddress) {
    actions.push({
      type: 'CONTRACT_DEPLOY',
      value: receipt.contractAddress
    });
  }

  // ETH transfer (native)
  if (tx.value && tx.value > 0n && tx.to) {
    const ethUsd = await getEthUsd().catch(() => null);
    const eth = Number(ethers.formatEther(tx.value));
    const usd = ethUsd ? eth * ethUsd : null;
    if (isBridgeTarget && usd != null && usd > 0) {
      if (!bestBridge || usd > bestBridge.usd) bestBridge = { asset: 'ETH', symbol: 'ETH', eth, usd };
    }
    if (fromAlways || (usd != null && usd > minUsd)) {
      actions.push({
        type: 'ETH_TRANSFER',
        direction: fromMon && !toMon ? 'OUT' : !fromMon && toMon ? 'IN' : fromMon && toMon ? 'INTERNAL' : 'OTHER',
        from,
        to,
        eth,
        usd
      });
    }
  }

  // Parse receipt logs for token/NFT events
  for (const log of receipt.logs || []) {
    const t0 = log.topics?.[0];
    if (!t0) continue;

    // Ignore approvals (handled by isApprovalOnly too)
    if (t0 === TOPIC_APPROVAL || t0 === TOPIC_APPROVAL_FOR_ALL) continue;

    if (t0 === TOPIC_TRANSFER) {
      // ERC20 or ERC721 (same signature)
      if (log.topics.length === 3) {
        // ERC20 Transfer(address,address,uint256)
        const eFrom = topicToAddress(log.topics[1]);
        const eTo = topicToAddress(log.topics[2]);
        if (!isMonitored(eFrom) && !isMonitored(eTo) && !fromMon && !toMon) continue;
        const outboundFromAlways = Boolean(fromAlways && from && eFrom.toLowerCase() === from.toLowerCase());

        const token = ethers.getAddress(log.address);
        const amount = ethers.getBigInt(log.data);

        // Best-effort token info + pricing. If outbound from an always-alert wallet, we still alert even when USD can't be computed.
        const [info, px] = await Promise.all([getTokenInfo(token).catch(() => null), getTokenUsd(token).catch(() => null)]);
        const symbol = info?.symbol || null;
        const decimals = typeof info?.decimals === 'number' ? info.decimals : null;
        const qty = decimals != null ? Number(ethers.formatUnits(amount, decimals)) : null;
        const usd = qty != null && px ? qty * px : null;
        if (isBridgeTarget && from && eFrom.toLowerCase() === from.toLowerCase() && usd > 0) {
          if (!bestBridge || usd > bestBridge.usd) {
            bestBridge = { asset: 'ERC20', token, symbol: symbol || 'TOKEN', qty, usd };
          }
        }

        if (!outboundFromAlways) {
          if (usd == null) continue;
          if (usd <= minUsd) continue;
        }

        actions.push({
          type: 'ERC20_TRANSFER',
          token,
          symbol: symbol || 'TOKEN',
          from: eFrom,
          to: eTo,
          direction:
            isMonitored(eFrom) && !isMonitored(eTo)
              ? 'OUT'
              : !isMonitored(eFrom) && isMonitored(eTo)
                ? 'IN'
                : isMonitored(eFrom) && isMonitored(eTo)
                  ? 'INTERNAL'
                  : 'OTHER',
          qty,
          rawAmount: amount.toString(),
          usd
        });
      } else if (log.topics.length === 4) {
        // ERC721 Transfer(address,address,uint256 tokenId)
        const eFrom = topicToAddress(log.topics[1]);
        const eTo = topicToAddress(log.topics[2]);
        const tokenId = ethers.getBigInt(log.topics[3]);
        const isMint = eFrom.toLowerCase() === ZERO_ADDRESS.toLowerCase();
        const involved = isMonitored(eTo) || isMonitored(eFrom) || fromMon || toMon;
        if (!involved) continue;
        if (!isMint) continue; // only mint events per requirements

        const collection = ethers.getAddress(log.address);
        const name = await getContractNameMaybe(collection);
        actions.push({
          type: 'ERC721_MINT',
          collection,
          name,
          to: eTo,
          tokenId: tokenId.toString()
        });
      }
    }

    if (t0 === TOPIC_ERC1155_SINGLE) {
      const eFrom = topicToAddress(log.topics[2]);
      const eTo = topicToAddress(log.topics[3]);
      const isMint = eFrom.toLowerCase() === ZERO_ADDRESS.toLowerCase();
      const involved = isMonitored(eTo) || isMonitored(eFrom) || fromMon || toMon;
      if (!involved || !isMint) continue;
      const [id, value] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], log.data);
      actions.push({
        type: 'ERC1155_MINT',
        collection: ethers.getAddress(log.address),
        to: eTo,
        tokenId: id.toString(),
        amount: value.toString()
      });
    }

    if (t0 === TOPIC_ERC1155_BATCH) {
      const eFrom = topicToAddress(log.topics[2]);
      const eTo = topicToAddress(log.topics[3]);
      const isMint = eFrom.toLowerCase() === ZERO_ADDRESS.toLowerCase();
      const involved = isMonitored(eTo) || isMonitored(eFrom) || fromMon || toMon;
      if (!involved || !isMint) continue;
      const [ids, values] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256[]', 'uint256[]'], log.data);
      actions.push({
        type: 'ERC1155_MINT_BATCH',
        collection: ethers.getAddress(log.address),
        to: eTo,
        items: ids.map((id, i) => ({ id: id.toString(), amount: values[i].toString() }))
      });
    }
  }

  const bridgeFired = Boolean(isBridgeTarget && bestBridge?.usd != null && (fromAlways || bestBridge.usd > minBridgeUsd));
  if (bridgeFired) {
    actions.length = 0;
    actions.push({
      type: 'BRIDGE',
      from,
      to,
      ...bestBridge
    });
  }

  // Swap tracking for always-alert wallets.
  if (!bridgeFired && fromAlways && tx.to && methodId && !APPROVAL_SELECTORS.has(methodId)) {
    const swapLike = SWAP_SELECTORS.has(methodId) || isSwapProtocolTarget;
    if (swapLike) {
      actions.unshift({
        type: 'SWAP',
        from,
        to,
        methodId,
        protocol: toKnownLabel
      });
    }
  }

  // Outgoing-only mode: keep only transfers/swaps/bridges initiated by monitored sender wallets.
  if (outgoingOnly) {
    if (!fromMon || !from) {
      actions.length = 0;
    } else {
      const sender = from.toLowerCase();
      const filtered = actions.filter((action) => {
        if ((action.type === 'SWAP' || action.type === 'BRIDGE') && action.from) {
          try {
            return ethers.getAddress(action.from).toLowerCase() === sender;
          } catch {
            return false;
          }
        }
        if ((action.type === 'ETH_TRANSFER' || action.type === 'ERC20_TRANSFER') && action.from) {
          try {
            return ethers.getAddress(action.from).toLowerCase() === sender;
          } catch {
            return false;
          }
        }
        return false;
      });
      actions.length = 0;
      actions.push(...filtered);
    }
  } else if (fromAlways && from) {
    const sender = from.toLowerCase();
    const filtered = actions.filter((action) => {
      if (action.type === 'SWAP' || action.type === 'BRIDGE') return true;
      if ((action.type === 'ETH_TRANSFER' || action.type === 'ERC20_TRANSFER') && action.from) {
        try {
          return ethers.getAddress(action.from).toLowerCase() === sender;
        } catch {
          return false;
        }
      }
      return false;
    });
    actions.length = 0;
    actions.push(...filtered);
  }

  // Only alert contract calls if the target contract is newly deployed (<= NEW_CONTRACT_DAYS).
  if (!fromAlways && !bridgeFired && fromMon && tx.to && methodId && !APPROVAL_SELECTORS.has(methodId)) {
    const created = await getNewlyDeployedInfo(to, network);
    if (created) {
      const label = knownContracts.get(to.toLowerCase()) || null;
      actions.push({
        type: 'NEW_CONTRACT_INTERACTION',
        label,
        to,
        methodId,
        createdAtMs: created.createdAtMs,
        createdBlock: created.createdBlock ?? null
      });
    }
  }

  if (!fromAlways && isApprovalOnly(tx, receipt, actions.length > 0)) return;

  const forceAllTx = alertAllTx && !fromAlways;
  if (actions.length === 0 && forceAllTx && (outgoingOnly ? fromMon : fromMon || toMon)) {
    actions.push({
      type: 'TX',
      from,
      to,
      direction: fromMon && !toMon ? 'OUT' : !fromMon && toMon ? 'IN' : fromMon && toMon ? 'INTERNAL' : 'OTHER',
      valueEth: tx.value ? Number(ethers.formatEther(tx.value)) : 0,
      methodId
    });
  }
  if (actions.length === 0) return;

  const walletFromActions =
    actions
      .map((a) => (a?.from && isMonitored(a.from) ? a.from : a?.to && isMonitored(a.to) ? a.to : null))
      .find(Boolean) ?? null;

  const wallet = fromMon ? from : toMon ? to : walletFromActions ?? from ?? '(unknown)';
  const dest = tx.to ? to : receipt?.contractAddress ? receipt.contractAddress : '(unknown)';
  const destLabel = typeof dest === 'string' ? await getAddressLabelMaybe(dest, network) : null;
  const explorer = network.chainId === 1n ? 'https://etherscan.io' : null;
  const txHref = explorer ? `${explorer}/tx/${tx.hash}` : null;

  const primary = actions[0];
  const dedupKey = buildAlertDedupKey({
    network,
    txHash: tx.hash,
    blockNumber,
    trackedWallet: wallet,
    actionType: primary?.type
  });
  if (hasRecentAlertKey(dedupKey)) {
    if (debug) console.log(`skip duplicate alert tx=${tx.hash} key=${dedupKey}`);
    return;
  }

  const walletLabel = getWalletLabelMaybe(wallet) || (from ? await getAddressLabelMaybe(from, network) : null) || shortAddrMaybe(wallet) || 'Wallet';
  const walletRole = getWalletRoleMaybe(wallet);
  const walletDesc = getWalletDescriptionMaybe(wallet);

  let titleText = `${walletLabel} activity`;
  if (primary?.type === 'BRIDGE') {
    const sym = primary.symbol || (primary.asset === 'ETH' ? 'ETH' : 'TOKEN');
    titleText = `${walletLabel} bridged ${formatUsd(primary.usd)} ${sym}`.trim();
  } else if (primary?.type === 'SWAP') {
    titleText = `${walletLabel} swapped${primary.protocol ? ` on ${primary.protocol}` : ''}`;
  } else if (primary?.type === 'ETH_TRANSFER') {
    const amountText = primary.usd != null ? formatUsd(primary.usd) : `${primary.eth.toFixed(6)} ETH`;
    titleText = `${walletLabel} ${primary.direction === 'IN' ? 'received' : 'sent'} ${amountText}`;
  } else if (primary?.type === 'ERC20_TRANSFER') {
    const amountText = primary.usd != null ? `${formatUsd(primary.usd)} ${primary.symbol || ''}`.trim() : `${primary.symbol || 'TOKEN'}`;
    titleText = `${walletLabel} ${primary.direction === 'IN' ? 'received' : 'sent'} ${amountText}`.trim();
  } else if (primary?.type === 'CONTRACT_DEPLOY') {
    titleText = `${walletLabel} deployed a new contract`;
  } else if (primary?.type === 'NEW_CONTRACT_INTERACTION') {
    const targetLabel = (primary.to ? await getAddressLabelMaybe(primary.to, network) : null) || 'a new contract';
    titleText = `${walletLabel} interacted with ${targetLabel}`;
  } else if (primary?.type === 'ERC721_MINT' || primary?.type === 'ERC1155_MINT' || primary?.type === 'ERC1155_MINT_BATCH') {
    titleText = `${walletLabel} minted an NFT`;
  }

  const title = `<b>${escapeHtml(titleText)}</b>`;
  const lines = [];
  if (walletRole) lines.push(`<b>ROLE</b>: ${escapeHtml(walletRole)}`);
  if (walletDesc) lines.push(`<b>DESC</b>: ${escapeHtml(walletDesc)}`);

  // Clean format: show only sender/receiver addresses and minimal value details.
  if (primary?.type === 'BRIDGE') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(primary.from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    if (primary.asset === 'ETH') {
      lines.push(`<b>VALUE</b>: <b>${escapeHtml(formatUsd(primary.usd))}</b> (<code>${escapeHtml(Number(primary.eth).toFixed(6))}</code> ETH)`);
    } else {
      lines.push(`<b>TOKEN</b>: <b>${escapeHtml(primary.symbol || 'TOKEN')}</b>`);
      lines.push(
        `<b>AMOUNT</b>: <code>${escapeHtml(Number(primary.qty).toLocaleString('en-US', { maximumFractionDigits: 6 }))}</code> <b>${escapeHtml(primary.symbol || 'TOKEN')}</b>`
      );
      lines.push(`<b>VALUE</b>: <b>${escapeHtml(formatUsd(primary.usd))}</b>`);
    }
  } else if (primary?.type === 'SWAP') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(primary.from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    if (primary.protocol) lines.push(`<b>PROTOCOL</b>: <b>${escapeHtml(primary.protocol)}</b>`);
  } else if (primary?.type === 'ETH_TRANSFER') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(primary.from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    if (primary.usd != null) {
      lines.push(`<b>VALUE</b>: <b>${escapeHtml(formatUsd(primary.usd))}</b> (<code>${escapeHtml(primary.eth.toFixed(6))}</code> ETH)`);
    } else {
      lines.push(`<b>VALUE</b>: <code>${escapeHtml(primary.eth.toFixed(6))}</code> ETH`);
    }
  } else if (primary?.type === 'ERC20_TRANSFER') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(primary.from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    lines.push(`<b>TOKEN</b>: <b>${escapeHtml(primary.symbol)}</b>`);
    if (typeof primary.qty === 'number' && Number.isFinite(primary.qty)) {
      lines.push(
        `<b>AMOUNT</b>: <code>${escapeHtml(primary.qty.toLocaleString('en-US', { maximumFractionDigits: 6 }))}</code> <b>${escapeHtml(primary.symbol)}</b>`
      );
    } else if (primary.rawAmount) {
      lines.push(`<b>AMOUNT</b>: <code>${escapeHtml(primary.rawAmount)}</code> <b>${escapeHtml(primary.symbol)}</b>`);
    }
    if (primary.usd != null) lines.push(`<b>VALUE</b>: <b>${escapeHtml(formatUsd(primary.usd))}</b>`);
  } else if (primary?.type === 'CONTRACT_DEPLOY') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.value, network)}`);
  } else if (primary?.type === 'NEW_CONTRACT_INTERACTION') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(from, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
  } else if (primary?.type === 'ERC721_MINT') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(ZERO_ADDRESS, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    const colLabel = primary.name || (primary.collection ? await getAddressLabelMaybe(primary.collection, network) : null);
    if (colLabel) lines.push(`<b>COLLECTION</b>: <b>${escapeHtml(colLabel)}</b>`);
    lines.push(`<b>TOKEN_ID</b>: <code>${escapeHtml(primary.tokenId)}</code>`);
  } else if (primary?.type === 'ERC1155_MINT') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(ZERO_ADDRESS, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    const colLabel = primary.collection ? await getAddressLabelMaybe(primary.collection, network) : null;
    if (colLabel) lines.push(`<b>COLLECTION</b>: <b>${escapeHtml(colLabel)}</b>`);
    lines.push(`<b>TOKEN_ID</b>: <code>${escapeHtml(primary.tokenId)}</code>`);
    lines.push(`<b>AMOUNT</b>: <code>${escapeHtml(primary.amount)}</code>`);
  } else if (primary?.type === 'ERC1155_MINT_BATCH') {
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(ZERO_ADDRESS, network)}`);
    lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(primary.to, network)}`);
    const colLabel = primary.collection ? await getAddressLabelMaybe(primary.collection, network) : null;
    if (colLabel) lines.push(`<b>COLLECTION</b>: <b>${escapeHtml(colLabel)}</b>`);
    const shown = primary.items.slice(0, 6).map((it) => `${it.id}x${it.amount}`).join(', ');
    lines.push(`<b>ITEMS</b>: <code>${escapeHtml(shown)}${primary.items.length > 6 ? ` +${primary.items.length - 6} more` : ''}</code>`);
  } else {
    // Fallback: show tx sender/receiver only
    lines.push(`<b>FROM</b>: ${await fmtAddrWithLabel(from, network)}`);
    if (tx.to) lines.push(`<b>TO</b>: ${await fmtAddrWithLabel(tx.to, network)}`);
  }

  lines.push(`<b>CHAIN</b>: <code>${escapeHtml(getChainText(network))}</code>`);
  lines.push(`<b>TRACKED_WALLET</b>: ${await fmtAddrWithLabel(wallet, network)}`);
  lines.push(`<b>TX_HASH</b>: <code>${escapeHtml(tx.hash)}</code>`);
  lines.push(`<b>BLOCK</b>: <code>${escapeHtml(String(blockNumber))}</code>`);

  if (txHref) lines.push(`<b>TX</b>: ${fmtLink(txHref, 'Etherscan')}`);

  if (debug) console.log(`alert tx=${tx.hash} actions=${actions.length}`);
  let msg = [title, '', ...lines].join('\n');
  if (msg.length > 3900) msg = `${msg.slice(0, 3850)}\n...(truncated)`;
  await sendTelegramTracked(msg);
  if (telegramEnabled) {
    rememberAlertKey(dedupKey);
  }
}

async function handleBlock(blockNumber, network) {
  blocksProcessed += 1;
  const block = await provider.getBlock(blockNumber, true);
  if (!block) return;
  if (Array.isArray(block.transactions) && block.transactions.length > maxTxsPerBlock) return;

  const txByHash = new Map();
  for (const tx of block.transactions || []) txByHash.set(tx.hash, tx);

  const candidate = new Set();

  for (const tx of block.transactions || []) {
    const fromMon = tx.from && isMonitored(tx.from);
    const toMon = tx.to && isMonitored(tx.to);
    const deploy = !tx.to && fromMon;
    const known = fromMon && tx.to && knownContracts.has(ethers.getAddress(tx.to).toLowerCase());
    if (fromMon || toMon || deploy || known) candidate.add(tx.hash);
  }

  // Add ERC20/ERC721/1155 transfers involving monitored addresses (including incoming transfers).
  const logQueries = [
    { name: 'Transfer from', topics: [TOPIC_TRANSFER, monitoredTopics, null] },
    { name: 'Transfer to', topics: [TOPIC_TRANSFER, null, monitoredTopics] },
    { name: '1155 single from', topics: [TOPIC_ERC1155_SINGLE, null, monitoredTopics, null] },
    { name: '1155 single to', topics: [TOPIC_ERC1155_SINGLE, null, null, monitoredTopics] },
    { name: '1155 batch from', topics: [TOPIC_ERC1155_BATCH, null, monitoredTopics, null] },
    { name: '1155 batch to', topics: [TOPIC_ERC1155_BATCH, null, null, monitoredTopics] }
  ];

  // Chunk monitored topics to avoid oversized RPC payloads on some providers.
  const topicChunks = chunk(monitoredTopics, 12);
  for (const q of logQueries) {
    for (const topicsChunk of topicChunks) {
      const topics = q.topics.map((t) => (t === monitoredTopics ? topicsChunk : t));
      const logs = await provider
        .getLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics })
        .catch(() => []);
      for (const l of logs) candidate.add(l.transactionHash);
    }
  }

  const hashes = [...candidate];
  candidatesTotal += hashes.length;
  if (debug) console.log(`block ${blockNumber}: candidates=${hashes.length} txs=${block.transactions?.length ?? 0}`);
  await mapLimit(
    hashes,
    maxConcurrentReceipts,
    async (hash) => {
      const tx = txByHash.get(hash) || (await provider.getTransaction(hash).catch(() => null));
      if (!tx) return;
      const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
      if (!receipt) return;
      await handleTx(blockNumber, tx, receipt, network).catch((e) => {
        console.error(`tx ${hash} failed:`, e?.message || e);
      });
    }
  );
  lastProcessedBlock = blockNumber;
}

async function connectProvider() {
  const startupTimeoutMs = Number(settings.startupNetworkTimeoutMs ?? 15000);
  const httpPollingMs = Number(settings.httpPollingMs ?? 4000);
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error(`connect timeout after ${ms}ms`)), ms));

  if (WS_URL && !preferHttpProvider) {
    const wsProvider = new ethers.WebSocketProvider(WS_URL);
    // Prevent ws 'error' events from crashing the process during connect attempts.
    try {
      wsProvider.websocket?.on?.('error', () => {});
    } catch {
      // ignore
    }
    try {
      const network = await Promise.race([wsProvider.getNetwork(), timeout(startupTimeoutMs)]);
      return { provider: wsProvider, network, kind: 'websocket' };
    } catch (e) {
      try {
        wsProvider.destroy();
      } catch {
        // ignore
      }
      console.warn(`WebSocket connect failed (${e?.message || e}); falling back to HTTP polling.`);
    }
  }

  if (!RPC_URL) throw new Error('No RPC_URL available for HTTP polling fallback.');
  const httpProvider = new ethers.JsonRpcProvider(RPC_URL);
  httpProvider.pollingInterval = httpPollingMs;
  const network = await Promise.race([httpProvider.getNetwork(), timeout(startupTimeoutMs)]);
  return { provider: httpProvider, network, kind: `http polling (${httpPollingMs}ms)` };
}

function getArgValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const withEq = argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  return null;
}

async function runOnce(network, options = {}) {
  const stateFile = resolveStateFilePath(options.stateFile);
  const blocksPerRun = normalizePositiveInt(options.maxBlocks, maxBlocksPerRun);
  const state = loadStateFromFile(stateFile);
  setRunStateContext(stateFile, state, true);

  const latestBlock = await provider.getBlockNumber();
  if (state.lastProcessedBlock == null) {
    state.lastProcessedBlock = stateBootstrapLatest ? Math.max(0, latestBlock - 1) : 0;
    saveRunStateIfNeeded();
    console.log(`Initialized state file at block ${state.lastProcessedBlock}`);
  }

  const fromBlock = state.lastProcessedBlock + 1;
  if (fromBlock > latestBlock) {
    console.log(`No new blocks. lastProcessedBlock=${state.lastProcessedBlock}, latestBlock=${latestBlock}`);
    return;
  }

  const toBlock = Math.min(latestBlock, fromBlock + blocksPerRun - 1);
  console.log(`Once run: processing blocks ${fromBlock}..${toBlock} (latest=${latestBlock}, cap=${blocksPerRun})`);

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    await handleBlock(bn, network);
    state.lastProcessedBlock = bn;
    saveRunStateIfNeeded();
  }

  console.log(
    `Once run complete: blocksProcessed=${blocksProcessed} candidatesTotal=${candidatesTotal} alertsBuilt=${alertsBuilt} telegramSends=${telegramSends}`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const validateOnly = argv.includes('--validate');
  const smokeOnly = argv.includes('--smoke');
  const telegramTest = argv.includes('--telegram-test');
  const onceMode = argv.includes('--once');
  const dryRun = argv.includes('--dry-run') || argv.includes('--no-telegram');
  const stateFileArg = getArgValue(argv, '--state');
  const maxBlocksArg = getArgValue(argv, '--max-blocks');
  preferHttpProvider = argv.includes('--http') || onceMode;
  const txHashArg = getArgValue(argv, '--tx');
  const backfillValue = getArgValue(argv, '--backfill');
  const backfillBlocks = backfillValue ? Math.max(0, Number.parseInt(backfillValue, 10) || 0) : 0;
  if (validateOnly) {
    // Quick env/config check without opening a WebSocket connection.
    console.log('tiCkr alerts validate OK');
    console.log(`WS_URL: ${WS_URL ? 'set' : 'missing'}`);
    console.log(`RPC_URL: ${RPC_URL ? 'set' : 'missing'}`);
    console.log(`Monitoring addresses: ${monitored.size}`);
    console.log(`Telegram: ${TELEGRAM_BOT_TOKEN ? 'set' : 'missing'} / chat_id: ${CHAT_ID ? 'set' : 'missing'}`);
    console.log(`Etherscan key: ${ETHERSCAN_API_KEY ? 'set' : 'missing'}`);
    console.log(`State file: ${resolveStateFilePath(stateFileArg)}`);
    return;
  }

  const conn = await connectProvider();
  provider = conn.provider;
  const network = conn.network;
  const providerKind = conn.kind;

  loadEtherscanLabelCache();
  loadEtherscanCreationCache();
  console.log(`Connected (${providerKind}): chainId=${network.chainId.toString()} name=${network.name}`);
  console.log(`Monitoring ${monitored.size} addresses; minUsd=${minUsd}; minBridgeUsd=${minBridgeUsd}`);
  console.log(`Always-alert mode: ${alwaysAlertAll ? 'all addresses' : `${configuredAlwaysAlert.size} selected addresses`}`);
  console.log(`Outgoing-only mode: ${outgoingOnly ? 'on' : 'off'}`);
  console.log(`Known contracts: ${knownContracts.size}`);
  console.log(`Bridge targets: ${bridgeContracts.size}`);
  console.log(`Etherscan labeling: ${ETHERSCAN_API_KEY && network.chainId === 1n ? 'on' : 'off'}`);

  telegramEnabled = !dryRun;
  telegramDryRun = dryRun;

  if (onceMode) {
    await runOnce(network, {
      stateFile: stateFileArg,
      maxBlocks: maxBlocksArg
    });
    try {
      provider.destroy();
    } catch {
      // ignore
    }
    return;
  }

  if (txHashArg) {
    const hash = String(txHashArg).trim();
    console.log(`Process tx: ${hash}${dryRun ? ' [dry-run]' : ''}`);
    const tx = await provider.getTransaction(hash).catch(() => null);
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
    const blockNumber = receipt?.blockNumber ?? tx?.blockNumber ?? null;
    if (!tx || !receipt || blockNumber == null) {
      throw new Error('Could not load tx/receipt/blockNumber for --tx');
    }
    await handleTx(Number(blockNumber), tx, receipt, network);
    console.log(`Done: alertsBuilt=${alertsBuilt} telegramSends=${telegramSends}`);
    try {
      provider.destroy();
    } catch {
      // ignore
    }
    return;
  }

  if (startupPing) {
    await sendTelegramTracked(
      `tiCkr alerts started\nnetwork: ${network.name} (${network.chainId.toString()})\nprovider: ${providerKind}\nwallets: ${monitored.size}`
    ).catch((e) => console.error('startup ping failed:', e?.message || e));
  }

  if (heartbeatMinutes > 0) {
    const ms = Math.max(1, heartbeatMinutes) * 60_000;
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const idleMin = lastAlertAt ? Math.round((now - lastAlertAt) / 60_000) : null;
      const msg =
        `tiCkr heartbeat\n` +
        `last seen block: ${lastSeenBlock || 'n/a'}\n` +
        `last processed block: ${lastProcessedBlock || 'n/a'}\n` +
        `last alert: ${idleMin == null ? 'none yet' : `${idleMin} min ago`}`;
      sendTelegramTracked(msg).catch((e) => console.error('heartbeat failed:', e?.message || e));
    }, ms);
    heartbeatTimer.unref?.();
  }

  if (smokeOnly) {
    const bn = await provider.getBlockNumber().catch(() => null);
    console.log(`Latest block: ${bn ?? 'n/a'}`);
    if (telegramTest) {
      await sendTelegramTracked(`tiCkr alerts test\nnetwork: ${network.name} (${network.chainId.toString()})\nprovider: ${providerKind}`);
      console.log(`Telegram: ${dryRun ? 'dry-run (not sent)' : 'sent test message'}`);
    }
    try {
      provider.destroy();
    } catch {
      // ignore
    }
    return;
  }

  if (backfillBlocks > 0) {
    const latest = await provider.getBlockNumber();
    const from = Math.max(0, latest - backfillBlocks + 1);
    console.log(`Backfill: blocks ${from}..${latest} (${backfillBlocks})${dryRun ? ' [dry-run]' : ''}`);
    for (let bn = from; bn <= latest; bn++) {
      await handleBlock(bn, network).catch((e) => console.error(`backfill block ${bn} failed:`, e?.message || e));
    }
    console.log(
      `Backfill done: blocksProcessed=${blocksProcessed} candidatesTotal=${candidatesTotal} alertsBuilt=${alertsBuilt} telegramSends=${telegramSends}`
    );
    try {
      provider.destroy();
    } catch {
      // ignore
    }
    return;
  }

  let last = 0;
  let processing = Promise.resolve();
  provider.on('block', (bn) => {
    lastSeenBlock = bn;
    if (bn <= last) return;
    last = bn;
    processing = processing.then(() => handleBlock(bn, network)).catch((e) => {
      console.error('block handler failed:', e?.message || e);
    });
  });

  if (providerKind === 'websocket') {
    provider.on('error', (e) => {
      console.error('WebSocket provider error:', e?.message || e);
    });
  }
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exitCode = 1;
});
