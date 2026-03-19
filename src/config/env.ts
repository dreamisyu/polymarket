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

const requireEnv = (name: string): string => {
    const value = process.env[name];
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

const parseBoolean = (rawValue: string | undefined, fallback: boolean) => {
    if (rawValue === undefined) {
        return fallback;
    }

    return rawValue === '1' || rawValue.toLowerCase() === 'true';
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

const EXECUTION_MODE: ExecutionMode = process.env.EXECUTION_MODE === 'trace' ? 'trace' : 'live';
const TRACE_ID = process.env.TRACE_ID || 'default';
const TRACE_INITIAL_BALANCE = parsePositiveNumber(
    process.env.TRACE_INITIAL_BALANCE || '1000',
    'TRACE_INITIAL_BALANCE'
);

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
              CLOB_HTTP_URL: requireEnv('CLOB_HTTP_URL'),
              CLOB_WS_URL: requireEnv('CLOB_WS_URL'),
              USER_WS_URL:
                  process.env.USER_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
              RPC_URL: requireEnv('RPC_URL'),
              USDC_CONTRACT_ADDRESS: requireEnv('USDC_CONTRACT_ADDRESS'),
          }
        : {
              PROXY_WALLET: process.env.PROXY_WALLET || '',
              PRIVATE_KEY: process.env.PRIVATE_KEY || '',
              CLOB_HTTP_URL: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',
              CLOB_WS_URL:
                  process.env.CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
              USER_WS_URL:
                  process.env.USER_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
              RPC_URL: process.env.RPC_URL || '',
              USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS || '',
          };

if (EXECUTION_MODE === 'live') {
    validatePrivateKey(liveOnlyEnv.PRIVATE_KEY);
}

export const ENV = {
    EXECUTION_MODE,
    TRACE_ID,
    TRACE_LABEL: `trace:${TRACE_ID}`,
    TRACE_INITIAL_BALANCE,
    USER_ADDRESS,
    MONGO_URI,
    PROXY_WALLET: liveOnlyEnv.PROXY_WALLET,
    PRIVATE_KEY: liveOnlyEnv.PRIVATE_KEY,
    CLOB_HTTP_URL: liveOnlyEnv.CLOB_HTTP_URL,
    CLOB_WS_URL: liveOnlyEnv.CLOB_WS_URL,
    USER_WS_URL: liveOnlyEnv.USER_WS_URL,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    MAX_SLIPPAGE_BPS: parseNonNegativeNumber(
        process.env.MAX_SLIPPAGE_BPS || '300',
        'MAX_SLIPPAGE_BPS'
    ),
    MAX_ORDER_USDC: parseNonNegativeNumber(process.env.MAX_ORDER_USDC || '0', 'MAX_ORDER_USDC'),
    PROCESSING_LEASE_MS: parsePositiveInteger(
        process.env.PROCESSING_LEASE_MS || '30000',
        'PROCESSING_LEASE_MS'
    ),
    ORDER_CONFIRMATION_TIMEOUT_MS: parsePositiveInteger(
        process.env.ORDER_CONFIRMATION_TIMEOUT_MS || '45000',
        'ORDER_CONFIRMATION_TIMEOUT_MS'
    ),
    ORDER_CONFIRMATION_POLL_MS: parsePositiveInteger(
        process.env.ORDER_CONFIRMATION_POLL_MS || '2000',
        'ORDER_CONFIRMATION_POLL_MS'
    ),
    ORDER_CONFIRMATION_BLOCKS: parsePositiveInteger(
        process.env.ORDER_CONFIRMATION_BLOCKS || '2',
        'ORDER_CONFIRMATION_BLOCKS'
    ),
    AUTO_REDEEM_ENABLED: parseBoolean(process.env.AUTO_REDEEM_ENABLED, true),
    AUTO_REDEEM_INTERVAL_MS: parsePositiveInteger(
        process.env.AUTO_REDEEM_INTERVAL_MS || '30000',
        'AUTO_REDEEM_INTERVAL_MS'
    ),
    AUTO_REDEEM_MAX_CONDITIONS_PER_RUN: parsePositiveInteger(
        process.env.AUTO_REDEEM_MAX_CONDITIONS_PER_RUN || '8',
        'AUTO_REDEEM_MAX_CONDITIONS_PER_RUN'
    ),
    ACTIVITY_SYNC_LIMIT: parsePositiveInteger(
        process.env.ACTIVITY_SYNC_LIMIT || '500',
        'ACTIVITY_SYNC_LIMIT'
    ),
    ACTIVITY_SYNC_OVERLAP_MS: parsePositiveInteger(
        process.env.ACTIVITY_SYNC_OVERLAP_MS || '30000',
        'ACTIVITY_SYNC_OVERLAP_MS'
    ),
    SNAPSHOT_STALE_AFTER_MS: parsePositiveInteger(
        process.env.SNAPSHOT_STALE_AFTER_MS || '30000',
        'SNAPSHOT_STALE_AFTER_MS'
    ),
    MARKET_CACHE_TTL_MS: parsePositiveInteger(
        process.env.MARKET_CACHE_TTL_MS || '3000',
        'MARKET_CACHE_TTL_MS'
    ),
    MARKET_WS_RECONNECT_MS: parsePositiveInteger(
        process.env.MARKET_WS_RECONNECT_MS || '1000',
        'MARKET_WS_RECONNECT_MS'
    ),
    USER_WS_RECONNECT_MS: parsePositiveInteger(
        process.env.USER_WS_RECONNECT_MS || '1000',
        'USER_WS_RECONNECT_MS'
    ),
    MARKET_WS_SNAPSHOT_WAIT_MS: parsePositiveInteger(
        process.env.MARKET_WS_SNAPSHOT_WAIT_MS || '750',
        'MARKET_WS_SNAPSHOT_WAIT_MS'
    ),
    MARKET_WS_ENABLED: parseBoolean(process.env.MARKET_WS_ENABLED, true),
    RPC_URL: liveOnlyEnv.RPC_URL,
    USDC_CONTRACT_ADDRESS: liveOnlyEnv.USDC_CONTRACT_ADDRESS,
    POLYMARKET_RELAYER_URL:
        process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com',
    POLYMARKET_RELAYER_TX_TYPE: parseRelayerTransactionMode(
        process.env.POLYMARKET_RELAYER_TX_TYPE,
        'SAFE'
    ),
    POLYMARKET_CTF_CONTRACT_ADDRESS:
        process.env.POLYMARKET_CTF_CONTRACT_ADDRESS || '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
    POLY_BUILDER_API_KEY: process.env.POLY_BUILDER_API_KEY || '',
    POLY_BUILDER_SECRET: process.env.POLY_BUILDER_SECRET || '',
    POLY_BUILDER_PASSPHRASE: process.env.POLY_BUILDER_PASSPHRASE || '',
};
