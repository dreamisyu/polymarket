import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT_DIR = resolve(__dirname, '../../');
const ENV_PATH_CANDIDATES = Array.from(
    new Set([resolve(process.cwd(), '.env'), resolve(PROJECT_ROOT_DIR, '.env')])
);
const ENV_FILE_PATH =
    ENV_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    resolve(PROJECT_ROOT_DIR, '.env');

dotenv.config({ path: ENV_FILE_PATH });

type ExecutionMode = 'live' | 'trace';
type RelayerTransactionMode = 'SAFE' | 'PROXY';
type WsChannel = 'market' | 'user';
type BuyDustResidualMode = 'off' | 'defer' | 'trim';
type BuySizingMode = 'ratio' | 'first_entry_ticket';
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const DEFAULT_CLOB_HTTP_URL = 'https://clob.polymarket.com';
const DEFAULT_POLYMARKET_WS_BASE_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws';
const DEFAULT_RPC_URL = 'https://polygon.drpc.org';
const DEFAULT_USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const DEFAULT_POLYMARKET_RELAYER_URL = 'https://relayer-v2.polymarket.com';
const DEFAULT_POLYMARKET_CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';

const readEnv = (...names: string[]): string | undefined => {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value !== 'string') {
            continue;
        }

        const normalized = value.trim();
        if (normalized) {
            return normalized;
        }
    }

    return undefined;
};

const requireEnv = (name: string): string => {
    const value = readEnv(name);
    if (!value) {
        throw new Error(`${name} is not defined (loaded from ${ENV_FILE_PATH})`);
    }

    return value;
};

const parsePositiveNumber = (rawValue: string, name: string): number => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive number`);
    }

    return parsed;
};

const parseNonNegativeNumber = (rawValue: string, name: string): number => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }

    return parsed;
};

const parsePositiveInteger = (rawValue: string, name: string): number => {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
};

const parseNonNegativeInteger = (rawValue: string, name: string): number => {
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }

    return parsed;
};

const parseBoolean = (rawValue: string | undefined, fallback: boolean) => {
    if (rawValue === undefined) {
        return fallback;
    }

    return rawValue === '1' || rawValue.toLowerCase() === 'true';
};

const parseLogLevel = (rawValue: string | undefined, fallback: LogLevel): LogLevel => {
    const normalized = String(rawValue || fallback)
        .trim()
        .toLowerCase();

    if (
        normalized === 'trace' ||
        normalized === 'debug' ||
        normalized === 'info' ||
        normalized === 'warn' ||
        normalized === 'error' ||
        normalized === 'fatal'
    ) {
        return normalized;
    }

    throw new Error('LOG_LEVEL must be trace, debug, info, warn, error or fatal');
};

const parseRelayerTransactionMode = (
    rawValue: string | undefined,
    fallback: RelayerTransactionMode
): RelayerTransactionMode => {
    const normalized = String(rawValue || fallback)
        .trim()
        .toUpperCase();
    if (normalized === 'SAFE' || normalized === 'PROXY') {
        return normalized;
    }

    throw new Error('POLYMARKET_RELAYER_TX_TYPE must be SAFE or PROXY');
};

const parseBuyDustResidualMode = (
    rawValue: string | undefined,
    fallback: BuyDustResidualMode
): BuyDustResidualMode => {
    const normalized = String(rawValue || fallback)
        .trim()
        .toLowerCase();
    if (normalized === 'off' || normalized === 'defer' || normalized === 'trim') {
        return normalized;
    }

    throw new Error('BUY_DUST_RESIDUAL_MODE must be off, defer or trim');
};

const parseBuySizingMode = (
    rawValue: string | undefined,
    fallback: BuySizingMode
): BuySizingMode => {
    const normalized = String(rawValue || fallback)
        .trim()
        .toLowerCase();
    if (normalized === 'ratio' || normalized === 'first_entry_ticket') {
        return normalized;
    }

    throw new Error('BUY_SIZING_MODE must be ratio or first_entry_ticket');
};

const buildWsChannelUrl = (baseUrl: string, channel: WsChannel) =>
    `${baseUrl.replace(/\/+$/, '')}/${channel}`;

const resolveWsUrl = (specificEnvName: 'CLOB_WS_URL' | 'USER_WS_URL', channel: WsChannel) =>
    readEnv(specificEnvName) ||
    buildWsChannelUrl(readEnv('POLYMARKET_WS_BASE_URL') || DEFAULT_POLYMARKET_WS_BASE_URL, channel);

const resolveInitialSyncLookbackMs = () => {
    const lookbackSECOND = readEnv('INITIAL_SYNC_LOOKBACK_SECOND');
    if (lookbackSECOND !== undefined) {
        return parseNonNegativeNumber(lookbackSECOND, 'INITIAL_SYNC_LOOKBACK_SECOND') * 1000;
    }

    return parseNonNegativeInteger('24', 'INITIAL_SYNC_LOOKBACK_SECOND') * 1000;
};

const EXECUTION_MODE: ExecutionMode = readEnv('EXECUTION_MODE') === 'trace' ? 'trace' : 'live';
const TRACE_ID = readEnv('TRACE_ID') || 'default';
const TRACE_INITIAL_BALANCE = parsePositiveNumber(
    readEnv('TRACE_INITIAL_BALANCE') || '1000',
    'TRACE_INITIAL_BALANCE'
);
const TRACE_SOURCE_LOOKBACK_MS = parseNonNegativeInteger(
    readEnv('TRACE_SOURCE_LOOKBACK_MS') || '0',
    'TRACE_SOURCE_LOOKBACK_MS'
);
const LOG_DEFAULT_LEVEL = parseLogLevel(readEnv('LOG_LEVEL'), 'info');
const LOG_CONSOLE_LEVEL = parseLogLevel(readEnv('LOG_CONSOLE_LEVEL'), LOG_DEFAULT_LEVEL);
const LOG_FILE_LEVEL = parseLogLevel(readEnv('LOG_FILE_LEVEL'), 'debug');
const LOG_CONSOLE_ENABLED = parseBoolean(readEnv('LOG_CONSOLE_ENABLED'), true);
const LOG_FILE_ENABLED = parseBoolean(readEnv('LOG_FILE_ENABLED'), true);
const LOG_FILE_PATH = readEnv('LOG_FILE_PATH') || 'logs/bot.log';
const INITIAL_SYNC_LOOKBACK_MS = resolveInitialSyncLookbackMs();
const POLYMARKET_WS_RECONNECT_MS = readEnv('POLYMARKET_WS_RECONNECT_MS');

const USER_ADDRESS = requireEnv('USER_ADDRESS');
const MONGO_URI = requireEnv('MONGO_URI');

// Validate private key format
const validatePrivateKey = (privateKey: string): void => {
    // Remove 0x prefix if present
    const key = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;

    // Check length (should be 64 hex characters)
    if (key.length !== 64) {
        throw new Error(
            `PRIVATE_KEY must be exactly 64 hex characters (without 0x prefix). Current length: ${key.length}. ` +
                `Please check your .env file and ensure PRIVATE_KEY is a valid 64-character hexadecimal string.`
        );
    }

    // Check if it's valid hexadecimal (only 0-9, a-f, A-F)
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(key)) {
        throw new Error(
            `PRIVATE_KEY contains invalid hexadecimal characters. ` +
                `Private key must only contain characters 0-9 and a-f (or A-F). ` +
                `Found invalid characters in: ${privateKey.substring(0, 20)}... ` +
                `Please check your .env file and ensure PRIVATE_KEY is a valid 64-character hexadecimal string (no 0x prefix).`
        );
    }
};

const liveOnlyEnv =
    EXECUTION_MODE === 'live'
        ? {
              PROXY_WALLET: requireEnv('PROXY_WALLET'),
              PRIVATE_KEY: requireEnv('PRIVATE_KEY'),
              CLOB_HTTP_URL: readEnv('CLOB_HTTP_URL') || DEFAULT_CLOB_HTTP_URL,
              CLOB_WS_URL: resolveWsUrl('CLOB_WS_URL', 'market'),
              USER_WS_URL: resolveWsUrl('USER_WS_URL', 'user'),
              RPC_URL: readEnv('RPC_URL') || DEFAULT_RPC_URL,
              USDC_CONTRACT_ADDRESS:
                  readEnv('USDC_CONTRACT_ADDRESS') || DEFAULT_USDC_CONTRACT_ADDRESS,
          }
        : {
              PROXY_WALLET: readEnv('PROXY_WALLET') || '',
              PRIVATE_KEY: readEnv('PRIVATE_KEY') || '',
              CLOB_HTTP_URL: readEnv('CLOB_HTTP_URL') || DEFAULT_CLOB_HTTP_URL,
              CLOB_WS_URL: resolveWsUrl('CLOB_WS_URL', 'market'),
              USER_WS_URL: resolveWsUrl('USER_WS_URL', 'user'),
              RPC_URL: readEnv('RPC_URL') || DEFAULT_RPC_URL,
              USDC_CONTRACT_ADDRESS:
                  readEnv('USDC_CONTRACT_ADDRESS') || DEFAULT_USDC_CONTRACT_ADDRESS,
          };

if (EXECUTION_MODE === 'live') {
    validatePrivateKey(liveOnlyEnv.PRIVATE_KEY);
}

export const ENV = {
    EXECUTION_MODE,
    TRACE_ID,
    TRACE_LABEL: `trace:${TRACE_ID}`,
    TRACE_INITIAL_BALANCE,
    TRACE_SOURCE_LOOKBACK_MS,
    USER_ADDRESS,
    MONGO_URI,
    LOG_LEVEL: LOG_DEFAULT_LEVEL,
    LOG_CONSOLE_LEVEL,
    LOG_FILE_LEVEL,
    LOG_CONSOLE_ENABLED,
    LOG_FILE_ENABLED,
    LOG_FILE_PATH,
    PROXY_WALLET: liveOnlyEnv.PROXY_WALLET,
    PRIVATE_KEY: liveOnlyEnv.PRIVATE_KEY,
    CLOB_HTTP_URL: liveOnlyEnv.CLOB_HTTP_URL,
    CLOB_WS_URL: liveOnlyEnv.CLOB_WS_URL,
    USER_WS_URL: liveOnlyEnv.USER_WS_URL,
    FETCH_INTERVAL: parseInt(readEnv('FETCH_INTERVAL') || '1', 10),
    SETTLEMENT_SWEEP_INTERVAL_MS: parsePositiveInteger(
        readEnv('SETTLEMENT_SWEEP_INTERVAL_MS') || '5000',
        'SETTLEMENT_SWEEP_INTERVAL_MS'
    ),
    INITIAL_SYNC_LOOKBACK_MS,
    RETRY_LIMIT: parseInt(readEnv('RETRY_LIMIT') || '3', 10),
    MAX_SLIPPAGE_BPS: parseNonNegativeNumber(
        readEnv('MAX_SLIPPAGE_BPS') || '300',
        'MAX_SLIPPAGE_BPS'
    ),
    MAX_ORDER_USDC: parseNonNegativeNumber(readEnv('MAX_ORDER_USDC') || '0', 'MAX_ORDER_USDC'),
    PROCESSING_LEASE_MS: parsePositiveInteger(
        readEnv('PROCESSING_LEASE_MS') || '30000',
        'PROCESSING_LEASE_MS'
    ),
    ORDER_CONFIRMATION_TIMEOUT_MS: parsePositiveInteger(
        readEnv('ORDER_CONFIRMATION_TIMEOUT_MS') || '45000',
        'ORDER_CONFIRMATION_TIMEOUT_MS'
    ),
    ORDER_CONFIRMATION_POLL_MS: parsePositiveInteger(
        readEnv('ORDER_CONFIRMATION_POLL_MS') || '2000',
        'ORDER_CONFIRMATION_POLL_MS'
    ),
    ORDER_CONFIRMATION_BLOCKS: parsePositiveInteger(
        readEnv('ORDER_CONFIRMATION_BLOCKS') || '2',
        'ORDER_CONFIRMATION_BLOCKS'
    ),
    AUTO_REDEEM_ENABLED: parseBoolean(readEnv('AUTO_REDEEM_ENABLED'), true),
    AUTO_REDEEM_INTERVAL_MS: parsePositiveInteger(
        readEnv('AUTO_REDEEM_INTERVAL_MS') || '30000',
        'AUTO_REDEEM_INTERVAL_MS'
    ),
    AUTO_REDEEM_MAX_CONDITIONS_PER_RUN: parsePositiveInteger(
        readEnv('AUTO_REDEEM_MAX_CONDITIONS_PER_RUN') || '8',
        'AUTO_REDEEM_MAX_CONDITIONS_PER_RUN'
    ),
    ACTIVITY_SYNC_LIMIT: parsePositiveInteger(
        readEnv('ACTIVITY_SYNC_LIMIT') || '500',
        'ACTIVITY_SYNC_LIMIT'
    ),
    ACTIVITY_ADJACENT_MERGE_WINDOW_MS: parsePositiveInteger(
        readEnv('ACTIVITY_ADJACENT_MERGE_WINDOW_MS') || '15000',
        'ACTIVITY_ADJACENT_MERGE_WINDOW_MS'
    ),
    ACTIVITY_SYNC_OVERLAP_MS: parsePositiveInteger(
        readEnv('ACTIVITY_SYNC_OVERLAP_MS') || '30000',
        'ACTIVITY_SYNC_OVERLAP_MS'
    ),
    SNAPSHOT_STALE_AFTER_MS: parsePositiveInteger(
        readEnv('SNAPSHOT_STALE_AFTER_MS') || '30000',
        'SNAPSHOT_STALE_AFTER_MS'
    ),
    BUY_MIN_TOP_UP_ENABLED: parseBoolean(readEnv('BUY_MIN_TOP_UP_ENABLED'), true),
    BUY_MIN_TOP_UP_TRIGGER_USDC: parseNonNegativeNumber(
        readEnv('BUY_MIN_TOP_UP_TRIGGER_USDC') || '0.7',
        'BUY_MIN_TOP_UP_TRIGGER_USDC'
    ),
    BUY_BOOTSTRAP_MAX_ACTIVE_RATIO: parseNonNegativeNumber(
        readEnv('BUY_BOOTSTRAP_MAX_ACTIVE_RATIO') || '0.15',
        'BUY_BOOTSTRAP_MAX_ACTIVE_RATIO'
    ),
    BUY_INTENT_BUFFER_MAX_MS: parsePositiveInteger(
        readEnv('BUY_INTENT_BUFFER_MAX_MS') || '2000',
        'BUY_INTENT_BUFFER_MAX_MS'
    ),
    BUY_SIZING_MODE: parseBuySizingMode(readEnv('BUY_SIZING_MODE'), 'ratio'),
    BUY_FIRST_ENTRY_TICKET_USDC: parseNonNegativeNumber(
        readEnv('BUY_FIRST_ENTRY_TICKET_USDC') || '1',
        'BUY_FIRST_ENTRY_TICKET_USDC'
    ),
    BUY_FIRST_ENTRY_SIGNAL_MIN_USDC: parseNonNegativeNumber(
        readEnv('BUY_FIRST_ENTRY_SIGNAL_MIN_USDC') || '0.05',
        'BUY_FIRST_ENTRY_SIGNAL_MIN_USDC'
    ),
    BUY_DUST_RESIDUAL_MODE: parseBuyDustResidualMode(readEnv('BUY_DUST_RESIDUAL_MODE'), 'trim'),
    MARKET_CACHE_TTL_MS: parsePositiveInteger(
        readEnv('MARKET_CACHE_TTL_MS') || '3000',
        'MARKET_CACHE_TTL_MS'
    ),
    MARKET_WS_RECONNECT_MS: parsePositiveInteger(
        readEnv('MARKET_WS_RECONNECT_MS') || POLYMARKET_WS_RECONNECT_MS || '1000',
        'MARKET_WS_RECONNECT_MS'
    ),
    USER_WS_RECONNECT_MS: parsePositiveInteger(
        readEnv('USER_WS_RECONNECT_MS') || POLYMARKET_WS_RECONNECT_MS || '1000',
        'USER_WS_RECONNECT_MS'
    ),
    MARKET_WS_SNAPSHOT_WAIT_MS: parsePositiveInteger(
        readEnv('MARKET_WS_SNAPSHOT_WAIT_MS') || '750',
        'MARKET_WS_SNAPSHOT_WAIT_MS'
    ),
    MARKET_WS_ENABLED: parseBoolean(readEnv('MARKET_WS_ENABLED'), true),
    LIVE_STATE_REFRESH_MS: parsePositiveInteger(
        readEnv('LIVE_STATE_REFRESH_MS') || '1000',
        'LIVE_STATE_REFRESH_MS'
    ),
    LIVE_EXECUTOR_LOOP_INTERVAL_MS: parsePositiveInteger(
        readEnv('LIVE_EXECUTOR_LOOP_INTERVAL_MS') || '100',
        'LIVE_EXECUTOR_LOOP_INTERVAL_MS'
    ),
    LIVE_PERSIST_MAX_QUEUE_SIZE: parsePositiveInteger(
        readEnv('LIVE_PERSIST_MAX_QUEUE_SIZE') || '2000',
        'LIVE_PERSIST_MAX_QUEUE_SIZE'
    ),
    LIVE_PERSIST_RETRY_MS: parsePositiveInteger(
        readEnv('LIVE_PERSIST_RETRY_MS') || '1000',
        'LIVE_PERSIST_RETRY_MS'
    ),
    RPC_URL: liveOnlyEnv.RPC_URL,
    USDC_CONTRACT_ADDRESS: liveOnlyEnv.USDC_CONTRACT_ADDRESS,
    POLYMARKET_RELAYER_URL: readEnv('POLYMARKET_RELAYER_URL') || DEFAULT_POLYMARKET_RELAYER_URL,
    POLYMARKET_RELAYER_TX_TYPE: parseRelayerTransactionMode(
        readEnv('POLYMARKET_RELAYER_TX_TYPE'),
        'SAFE'
    ),
    POLYMARKET_CTF_CONTRACT_ADDRESS:
        readEnv('POLYMARKET_CTF_CONTRACT_ADDRESS') || DEFAULT_POLYMARKET_CTF_CONTRACT_ADDRESS,
    POLY_BUILDER_API_KEY: readEnv('POLY_BUILDER_API_KEY') || '',
    POLY_BUILDER_SECRET: readEnv('POLY_BUILDER_SECRET') || '',
    POLY_BUILDER_PASSPHRASE: readEnv('POLY_BUILDER_PASSPHRASE') || '',
};
