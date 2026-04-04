import { z } from 'zod';
import type { RunMode, StrategyKind } from '@domain';
import { loadEnvFile } from '@config/loadEnv';

export type ClobSignatureType = 'EOA' | 'PROXY' | 'SAFE';
export type BuyDustResidualMode = 'off' | 'defer' | 'trim';
export type SignalMarketScope = 'all' | 'crypto_updown_5m';

export interface AppConfig {
    envFilePath: string;
    nodeEnv: string;
    logLevel: string;
    logFilePath?: string;
    runMode: RunMode;
    strategyKind: StrategyKind;
    sourceWallet: string;
    targetWallet: string;
    mongoUri: string;
    scopeKey: string;
    monitorIntervalMs: number;
    monitorInitialLookbackMs: number;
    monitorOverlapMs: number;
    activitySyncLimit: number;
    activityAdjacentMergeWindowMs: number;
    snapshotStaleAfterMs: number;
    retryBackoffMs: number;
    maxRetryCount: number;
    copytradeDispatchConcurrency: number;
    copytradeProcessingLeaseMs: number;
    settlementIntervalMs: number;
    settlementMaxTasksPerRun: number;
    fixedTradeAmountUsdc: number;
    proportionalCopyRatio: number;
    maxOpenPositions: number;
    maxActiveExposureUsdc: number;
    maxSignalAgeMs: number;
    marketWhitelist: string[];
    minSourceBuyUsdc: number;
    signalMarketScope: SignalMarketScope;
    signalWeakThresholdUsdc: number;
    signalNormalThresholdUsdc: number;
    signalStrongThresholdUsdc: number;
    signalWeakTicketUsdc: number;
    signalNormalTicketUsdc: number;
    signalStrongTicketUsdc: number;
    paperInitialBalance: number;
    clobHttpUrl: string;
    clobWsUrl: string;
    userWsUrl: string;
    dataApiUrl: string;
    gammaApiUrl: string;
    rpcUrl: string;
    marketWsReconnectMs: number;
    userWsReconnectMs: number;
    wsHeartbeatMs: number;
    marketBookStaleMs: number;
    marketWsBootstrapWaitMs: number;
    orderConfirmationTimeoutMs: number;
    orderConfirmationPollMs: number;
    orderConfirmationBlocks: number;
    liveConfirmTimeoutMs: number;
    liveReconcileAfterTimeoutMs: number;
    liveOrderMinIntervalMs: number;
    liveSettlementOnchainRedeemEnabled: boolean;
    maxSlippageBps: number;
    maxOrderUsdc: number;
    buyDustResidualMode: BuyDustResidualMode;
    clobSignatureType: ClobSignatureType;
    proxyWallet?: string;
    privateKey?: string;
    usdcContractAddress: string;
    ctfContractAddress: string;
    autoRedeemEnabled: boolean;
    autoRedeemMaxConditionsPerRun: number;
}

const defaultClobHttpUrl = 'https://clob.polymarket.com';
const defaultClobWsBaseUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws';
const defaultDataApiUrl = 'https://data-api.polymarket.com';
const defaultGammaApiUrl = 'https://gamma-api.polymarket.com';
const defaultRpcUrl = 'https://polygon.drpc.org';
const defaultUsdcContractAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const defaultCtfContractAddress = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';

const optionalTrimmedString = z
    .string()
    .optional()
    .transform((value) => {
        const normalized = String(value || '').trim();
        return normalized ? normalized : undefined;
    });

const stringWithDefault = (fallback: string) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const normalized = String(value || '').trim();
            return normalized || fallback;
        });

const parseNumber = (value: string | undefined, field: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${field} 必须是数字`);
    }

    return parsed;
};

const positiveNumberWithDefault = (field: string, fallback: number) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const normalized = String(value || '').trim();
            if (!normalized) {
                return fallback;
            }

            const parsed = parseNumber(normalized, field);
            if (parsed <= 0) {
                throw new Error(`${field} 必须是正数`);
            }

            return parsed;
        });

const optionalPositiveNumber = (field: string) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const normalized = String(value || '').trim();
            if (!normalized) {
                return undefined;
            }

            const parsed = parseNumber(normalized, field);
            if (parsed <= 0) {
                throw new Error(`${field} 必须是正数`);
            }

            return parsed;
        });

const nonNegativeNumberWithDefault = (field: string, fallback: number) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const normalized = String(value || '').trim();
            if (!normalized) {
                return fallback;
            }

            const parsed = parseNumber(normalized, field);
            if (parsed < 0) {
                throw new Error(`${field} 必须是非负数`);
            }

            return parsed;
        });

const booleanWithDefault = (fallback: boolean) =>
    z
        .string()
        .optional()
        .transform((value) => {
            const normalized = String(value || '')
                .trim()
                .toLowerCase();
            if (!normalized) {
                return fallback;
            }

            return normalized === '1' || normalized === 'true';
        });

const marketWhitelistField = z
    .string()
    .optional()
    .transform((value) => {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return [] as string[];
        }

        const items = Array.from(
            new Set(
                normalized
                    .split(',')
                    .map((item) => item.trim().toLowerCase())
                    .filter(Boolean)
            )
        );

        return items.includes('all') ? [] : items;
    });

const envSchema = z
    .object({
        NODE_ENV: stringWithDefault('development'),
        LOG_LEVEL: stringWithDefault('info'),
        LOG_FILE_PATH: optionalTrimmedString,
        RUN_MODE: z.enum(['live', 'paper']).default('paper'),
        STRATEGY_KIND: z
            .enum(['signal', 'fixed_amount', 'mirror', 'proportional'])
            .default('fixed_amount'),
        SOURCE_WALLET: z.string().trim().min(1, 'SOURCE_WALLET 未配置'),
        TARGET_WALLET: z.string().trim().min(1, 'TARGET_WALLET 未配置'),
        MONGO_URI: z.string().trim().min(1, 'MONGO_URI 未配置'),
        MONITOR_INTERVAL_MS: positiveNumberWithDefault('MONITOR_INTERVAL_MS', 5_000),
        MONITOR_INITIAL_LOOKBACK_MS: nonNegativeNumberWithDefault(
            'MONITOR_INITIAL_LOOKBACK_MS',
            24 * 60 * 60 * 1000
        ),
        MONITOR_OVERLAP_MS: nonNegativeNumberWithDefault('MONITOR_OVERLAP_MS', 30_000),
        ACTIVITY_SYNC_LIMIT: positiveNumberWithDefault('ACTIVITY_SYNC_LIMIT', 500),
        ACTIVITY_ADJACENT_MERGE_WINDOW_MS: nonNegativeNumberWithDefault(
            'ACTIVITY_ADJACENT_MERGE_WINDOW_MS',
            3_000
        ),
        SNAPSHOT_STALE_AFTER_MS: positiveNumberWithDefault('SNAPSHOT_STALE_AFTER_MS', 5 * 60_000),
        RETRY_BACKOFF_MS: positiveNumberWithDefault('RETRY_BACKOFF_MS', 2_000),
        MAX_RETRY_COUNT: positiveNumberWithDefault('MAX_RETRY_COUNT', 3),
        COPYTRADE_DISPATCH_CONCURRENCY: positiveNumberWithDefault(
            'COPYTRADE_DISPATCH_CONCURRENCY',
            4
        ),
        COPYTRADE_PROCESSING_LEASE_MS: positiveNumberWithDefault(
            'COPYTRADE_PROCESSING_LEASE_MS',
            5 * 60_000
        ),
        SETTLEMENT_INTERVAL_MS: positiveNumberWithDefault('SETTLEMENT_INTERVAL_MS', 30_000),
        SETTLEMENT_MAX_TASKS_PER_RUN: positiveNumberWithDefault('SETTLEMENT_MAX_TASKS_PER_RUN', 8),
        FIXED_TRADE_USDC: positiveNumberWithDefault('FIXED_TRADE_USDC', 20),
        PROPORTIONAL_COPY_RATIO: optionalPositiveNumber('PROPORTIONAL_COPY_RATIO'),
        MAX_OPEN_POSITIONS: positiveNumberWithDefault('MAX_OPEN_POSITIONS', 20),
        MAX_ACTIVE_EXPOSURE_USDC: positiveNumberWithDefault('MAX_ACTIVE_EXPOSURE_USDC', 1_000),
        MAX_SIGNAL_AGE_MS: nonNegativeNumberWithDefault('MAX_SIGNAL_AGE_MS', 15_000),
        MARKET_WHITELIST: marketWhitelistField,
        MIN_SOURCE_BUY_USDC: nonNegativeNumberWithDefault('MIN_SOURCE_BUY_USDC', 0),
        SIGNAL_MARKET_SCOPE: z.enum(['all', 'crypto_updown_5m']).default('all'),
        SIGNAL_WEAK_THRESHOLD_USDC: positiveNumberWithDefault('SIGNAL_WEAK_THRESHOLD_USDC', 50),
        SIGNAL_NORMAL_THRESHOLD_USDC: positiveNumberWithDefault(
            'SIGNAL_NORMAL_THRESHOLD_USDC',
            100
        ),
        SIGNAL_STRONG_THRESHOLD_USDC: positiveNumberWithDefault(
            'SIGNAL_STRONG_THRESHOLD_USDC',
            250
        ),
        SIGNAL_WEAK_TICKET_USDC: positiveNumberWithDefault('SIGNAL_WEAK_TICKET_USDC', 10),
        SIGNAL_NORMAL_TICKET_USDC: positiveNumberWithDefault('SIGNAL_NORMAL_TICKET_USDC', 25),
        SIGNAL_STRONG_TICKET_USDC: positiveNumberWithDefault('SIGNAL_STRONG_TICKET_USDC', 50),
        PAPER_INITIAL_BALANCE: nonNegativeNumberWithDefault('PAPER_INITIAL_BALANCE', 1_000),
        CLOB_HTTP_URL: stringWithDefault(defaultClobHttpUrl),
        CLOB_WS_URL: stringWithDefault(`${defaultClobWsBaseUrl}/market`),
        USER_WS_URL: stringWithDefault(`${defaultClobWsBaseUrl}/user`),
        DATA_API_URL: stringWithDefault(defaultDataApiUrl),
        GAMMA_API_URL: stringWithDefault(defaultGammaApiUrl),
        RPC_URL: stringWithDefault(defaultRpcUrl),
        MARKET_WS_RECONNECT_MS: positiveNumberWithDefault('MARKET_WS_RECONNECT_MS', 1_000),
        USER_WS_RECONNECT_MS: positiveNumberWithDefault('USER_WS_RECONNECT_MS', 1_000),
        WS_HEARTBEAT_MS: positiveNumberWithDefault('WS_HEARTBEAT_MS', 10_000),
        MARKET_BOOK_STALE_MS: positiveNumberWithDefault('MARKET_BOOK_STALE_MS', 2_500),
        MARKET_WS_BOOTSTRAP_WAIT_MS: positiveNumberWithDefault('MARKET_WS_BOOTSTRAP_WAIT_MS', 750),
        ORDER_CONFIRMATION_TIMEOUT_MS: positiveNumberWithDefault(
            'ORDER_CONFIRMATION_TIMEOUT_MS',
            30_000
        ),
        ORDER_CONFIRMATION_POLL_MS: positiveNumberWithDefault('ORDER_CONFIRMATION_POLL_MS', 2_000),
        ORDER_CONFIRMATION_BLOCKS: positiveNumberWithDefault('ORDER_CONFIRMATION_BLOCKS', 2),
        LIVE_CONFIRM_TIMEOUT_MS: positiveNumberWithDefault('LIVE_CONFIRM_TIMEOUT_MS', 60_000),
        LIVE_RECONCILE_AFTER_TIMEOUT_MS: positiveNumberWithDefault(
            'LIVE_RECONCILE_AFTER_TIMEOUT_MS',
            30_000
        ),
        LIVE_ORDER_MIN_INTERVAL_MS: nonNegativeNumberWithDefault('LIVE_ORDER_MIN_INTERVAL_MS', 250),
        LIVE_SETTLEMENT_ONCHAIN_REDEEM_ENABLED: booleanWithDefault(true),
        MAX_SLIPPAGE_BPS: nonNegativeNumberWithDefault('MAX_SLIPPAGE_BPS', 300),
        MAX_ORDER_USDC: nonNegativeNumberWithDefault('MAX_ORDER_USDC', 250),
        BUY_DUST_RESIDUAL_MODE: z.enum(['off', 'defer', 'trim']).default('trim'),
        CLOB_SIGNATURE_TYPE: z.enum(['EOA', 'PROXY', 'SAFE']).default('SAFE'),
        PROXY_WALLET: optionalTrimmedString,
        PRIVATE_KEY: optionalTrimmedString,
        USDC_CONTRACT_ADDRESS: stringWithDefault(defaultUsdcContractAddress),
        CTF_CONTRACT_ADDRESS: stringWithDefault(defaultCtfContractAddress),
        AUTO_REDEEM_ENABLED: booleanWithDefault(true),
        AUTO_REDEEM_MAX_CONDITIONS_PER_RUN: positiveNumberWithDefault(
            'AUTO_REDEEM_MAX_CONDITIONS_PER_RUN',
            8
        ),
    })
    .superRefine((value, ctx) => {
        if (value.runMode === 'live' && !value.PRIVATE_KEY) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PRIVATE_KEY'],
                message: 'live 模式缺少 PRIVATE_KEY',
            });
        }

        if (
            value.runMode === 'live' &&
            value.CLOB_SIGNATURE_TYPE !== 'EOA' &&
            !value.PROXY_WALLET
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PROXY_WALLET'],
                message: '代理签名模式缺少 PROXY_WALLET',
            });
        }

        if (value.STRATEGY_KIND === 'proportional' && value.PROPORTIONAL_COPY_RATIO === undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PROPORTIONAL_COPY_RATIO'],
                message: 'proportional 策略缺少 PROPORTIONAL_COPY_RATIO',
            });
        }
    });

let cachedConfig: AppConfig | null = null;

export const loadAppConfig = (): AppConfig => {
    if (cachedConfig) {
        return cachedConfig;
    }

    const envFilePath = loadEnvFile();
    const parsed = envSchema.parse(process.env);

    cachedConfig = {
        envFilePath,
        nodeEnv: parsed.NODE_ENV,
        logLevel: parsed.LOG_LEVEL.toLowerCase(),
        logFilePath: parsed.LOG_FILE_PATH,
        runMode: parsed.RUN_MODE,
        strategyKind: parsed.STRATEGY_KIND,
        sourceWallet: parsed.SOURCE_WALLET,
        targetWallet: parsed.TARGET_WALLET,
        mongoUri: parsed.MONGO_URI,
        scopeKey: `${parsed.SOURCE_WALLET}:${parsed.TARGET_WALLET}:${parsed.RUN_MODE}:${parsed.STRATEGY_KIND}`,
        monitorIntervalMs: parsed.MONITOR_INTERVAL_MS,
        monitorInitialLookbackMs: parsed.MONITOR_INITIAL_LOOKBACK_MS,
        monitorOverlapMs: parsed.MONITOR_OVERLAP_MS,
        activitySyncLimit: parsed.ACTIVITY_SYNC_LIMIT,
        activityAdjacentMergeWindowMs: parsed.ACTIVITY_ADJACENT_MERGE_WINDOW_MS,
        snapshotStaleAfterMs: parsed.SNAPSHOT_STALE_AFTER_MS,
        retryBackoffMs: parsed.RETRY_BACKOFF_MS,
        maxRetryCount: parsed.MAX_RETRY_COUNT,
        copytradeDispatchConcurrency: parsed.COPYTRADE_DISPATCH_CONCURRENCY,
        copytradeProcessingLeaseMs: parsed.COPYTRADE_PROCESSING_LEASE_MS,
        settlementIntervalMs: parsed.SETTLEMENT_INTERVAL_MS,
        settlementMaxTasksPerRun: parsed.SETTLEMENT_MAX_TASKS_PER_RUN,
        fixedTradeAmountUsdc: parsed.FIXED_TRADE_USDC,
        proportionalCopyRatio: parsed.PROPORTIONAL_COPY_RATIO || 1,
        maxOpenPositions: parsed.MAX_OPEN_POSITIONS,
        maxActiveExposureUsdc: parsed.MAX_ACTIVE_EXPOSURE_USDC,
        maxSignalAgeMs: parsed.MAX_SIGNAL_AGE_MS,
        marketWhitelist: parsed.MARKET_WHITELIST,
        minSourceBuyUsdc: parsed.MIN_SOURCE_BUY_USDC,
        signalMarketScope: parsed.SIGNAL_MARKET_SCOPE,
        signalWeakThresholdUsdc: parsed.SIGNAL_WEAK_THRESHOLD_USDC,
        signalNormalThresholdUsdc: parsed.SIGNAL_NORMAL_THRESHOLD_USDC,
        signalStrongThresholdUsdc: parsed.SIGNAL_STRONG_THRESHOLD_USDC,
        signalWeakTicketUsdc: parsed.SIGNAL_WEAK_TICKET_USDC,
        signalNormalTicketUsdc: parsed.SIGNAL_NORMAL_TICKET_USDC,
        signalStrongTicketUsdc: parsed.SIGNAL_STRONG_TICKET_USDC,
        paperInitialBalance: parsed.PAPER_INITIAL_BALANCE,
        clobHttpUrl: parsed.CLOB_HTTP_URL,
        clobWsUrl: parsed.CLOB_WS_URL,
        userWsUrl: parsed.USER_WS_URL,
        dataApiUrl: parsed.DATA_API_URL,
        gammaApiUrl: parsed.GAMMA_API_URL,
        rpcUrl: parsed.RPC_URL,
        marketWsReconnectMs: parsed.MARKET_WS_RECONNECT_MS,
        userWsReconnectMs: parsed.USER_WS_RECONNECT_MS,
        wsHeartbeatMs: parsed.WS_HEARTBEAT_MS,
        marketBookStaleMs: parsed.MARKET_BOOK_STALE_MS,
        marketWsBootstrapWaitMs: parsed.MARKET_WS_BOOTSTRAP_WAIT_MS,
        orderConfirmationTimeoutMs: parsed.ORDER_CONFIRMATION_TIMEOUT_MS,
        orderConfirmationPollMs: parsed.ORDER_CONFIRMATION_POLL_MS,
        orderConfirmationBlocks: parsed.ORDER_CONFIRMATION_BLOCKS,
        liveConfirmTimeoutMs: parsed.LIVE_CONFIRM_TIMEOUT_MS,
        liveReconcileAfterTimeoutMs: parsed.LIVE_RECONCILE_AFTER_TIMEOUT_MS,
        liveOrderMinIntervalMs: parsed.LIVE_ORDER_MIN_INTERVAL_MS,
        liveSettlementOnchainRedeemEnabled: parsed.LIVE_SETTLEMENT_ONCHAIN_REDEEM_ENABLED,
        maxSlippageBps: parsed.MAX_SLIPPAGE_BPS,
        maxOrderUsdc: parsed.MAX_ORDER_USDC,
        buyDustResidualMode: parsed.BUY_DUST_RESIDUAL_MODE,
        clobSignatureType: parsed.CLOB_SIGNATURE_TYPE,
        proxyWallet: parsed.PROXY_WALLET,
        privateKey: parsed.PRIVATE_KEY,
        usdcContractAddress: parsed.USDC_CONTRACT_ADDRESS,
        ctfContractAddress: parsed.CTF_CONTRACT_ADDRESS,
        autoRedeemEnabled: parsed.AUTO_REDEEM_ENABLED,
        autoRedeemMaxConditionsPerRun: parsed.AUTO_REDEEM_MAX_CONDITIONS_PER_RUN,
    };

    return cachedConfig;
};

export const resetAppConfigCache = () => {
    cachedConfig = null;
};
