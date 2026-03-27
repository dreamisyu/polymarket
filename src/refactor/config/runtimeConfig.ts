import { env } from './env';
import type { RunMode, StrategyKind } from '../domain';

export interface RuntimeConfig {
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
    settlementIntervalMs: number;
    fixedTradeAmountUsdc: number;
    maxOpenPositions: number;
    maxActiveExposureUsdc: number;
    signalMarketScope: 'all' | 'crypto_updown_5m';
    signalWeakThresholdUsdc: number;
    signalNormalThresholdUsdc: number;
    signalStrongThresholdUsdc: number;
    signalWeakTicketUsdc: number;
    signalNormalTicketUsdc: number;
    signalStrongTicketUsdc: number;
    paperInitialBalance: number;
    clobHttpUrl: string;
    dataApiUrl: string;
    gammaApiUrl: string;
    rpcUrl: string;
    marketWsUrl: string;
    userWsUrl: string;
    marketWsEnabled: boolean;
    marketCacheTtlMs: number;
    marketWsReconnectMs: number;
    marketWsSnapshotWaitMs: number;
    userWsReconnectMs: number;
    orderConfirmationTimeoutMs: number;
    orderConfirmationPollMs: number;
    orderConfirmationBlocks: number;
    liveConfirmTimeoutMs: number;
    liveReconcileAfterTimeoutMs: number;
    maxSlippageBps: number;
    maxOrderUsdc: number;
    buyDustResidualMode: 'off' | 'defer' | 'trim';
    proxyWallet?: string;
    privateKey?: string;
    relayerUrl?: string;
    relayerTxType: 'SAFE' | 'PROXY';
    usdcContractAddress: string;
    ctfContractAddress: string;
    autoRedeemEnabled: boolean;
    autoRedeemIntervalMs: number;
    autoRedeemMaxConditionsPerRun: number;
}

const defaultClobHttpUrl = 'https://clob.polymarket.com';
const defaultDataApiUrl = 'https://data-api.polymarket.com';
const defaultGammaApiUrl = 'https://gamma-api.polymarket.com';
const defaultRpcUrl = 'https://polygon.drpc.org';
const defaultMarketWsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const defaultUserWsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const defaultUsdcContractAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const defaultCtfContractAddress = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const defaultRelayerUrl = 'https://relayer-v2.polymarket.com';

const normalizeStrategyKind = (): StrategyKind =>
    env.toChoice('STRATEGY_KIND', ['signal', 'fixed_amount', 'proportional'] as const, 'fixed_amount');

const resolvePaperInitialBalance = () => env.toNonNegativeNumber('PAPER_INITIAL_BALANCE', 1_000);

export const loadRuntimeConfig = (): RuntimeConfig => {
    const runMode = env.toChoice('RUN_MODE', ['live', 'paper'] as const, 'paper');
    const strategyKind = normalizeStrategyKind();
    const sourceWallet = env.requireEnv('SOURCE_WALLET');
    const targetWallet = env.requireEnv('TARGET_WALLET');

    return {
        runMode,
        strategyKind,
        sourceWallet,
        targetWallet,
        mongoUri: env.requireEnv('MONGO_URI'),
        scopeKey: `${sourceWallet}:${targetWallet}:${runMode}:${strategyKind}`,
        monitorIntervalMs: env.toPositiveNumber('MONITOR_INTERVAL_MS', 5_000),
        monitorInitialLookbackMs: env.toNonNegativeNumber('MONITOR_INITIAL_LOOKBACK_MS', 24 * 60 * 60 * 1000),
        monitorOverlapMs: env.toNonNegativeNumber('MONITOR_OVERLAP_MS', 30_000),
        activitySyncLimit: env.toPositiveNumber('ACTIVITY_SYNC_LIMIT', 500),
        activityAdjacentMergeWindowMs: env.toNonNegativeNumber('ACTIVITY_ADJACENT_MERGE_WINDOW_MS', 3_000),
        snapshotStaleAfterMs: env.toPositiveNumber('SNAPSHOT_STALE_AFTER_MS', 5 * 60_000),
        retryBackoffMs: env.toPositiveNumber('RETRY_BACKOFF_MS', 2_000),
        maxRetryCount: env.toPositiveNumber('MAX_RETRY_COUNT', 3),
        settlementIntervalMs: env.toPositiveNumber('SETTLEMENT_INTERVAL_MS', 30_000),
        fixedTradeAmountUsdc: env.toPositiveNumber('FIXED_TRADE_USDC', 20),
        maxOpenPositions: env.toPositiveNumber('MAX_OPEN_POSITIONS', 20),
        maxActiveExposureUsdc: env.toPositiveNumber('MAX_ACTIVE_EXPOSURE_USDC', 1_000),
        signalMarketScope: env.toChoice('SIGNAL_MARKET_SCOPE', ['all', 'crypto_updown_5m'] as const, 'all'),
        signalWeakThresholdUsdc: env.toPositiveNumber('SIGNAL_WEAK_THRESHOLD_USDC', 50),
        signalNormalThresholdUsdc: env.toPositiveNumber('SIGNAL_NORMAL_THRESHOLD_USDC', 100),
        signalStrongThresholdUsdc: env.toPositiveNumber('SIGNAL_STRONG_THRESHOLD_USDC', 250),
        signalWeakTicketUsdc: env.toPositiveNumber('SIGNAL_WEAK_TICKET_USDC', 10),
        signalNormalTicketUsdc: env.toPositiveNumber('SIGNAL_NORMAL_TICKET_USDC', 25),
        signalStrongTicketUsdc: env.toPositiveNumber('SIGNAL_STRONG_TICKET_USDC', 50),
        paperInitialBalance: resolvePaperInitialBalance(),
        clobHttpUrl: env.readEnv('CLOB_HTTP_URL') || defaultClobHttpUrl,
        dataApiUrl: env.readEnv('DATA_API_URL') || defaultDataApiUrl,
        gammaApiUrl: env.readEnv('GAMMA_API_URL') || defaultGammaApiUrl,
        rpcUrl: env.readEnv('RPC_URL') || defaultRpcUrl,
        marketWsUrl: env.readEnv('MARKET_WS_URL') || defaultMarketWsUrl,
        userWsUrl: env.readEnv('USER_WS_URL') || defaultUserWsUrl,
        marketWsEnabled: env.toBoolean('MARKET_WS_ENABLED', true),
        marketCacheTtlMs: env.toPositiveNumber('MARKET_CACHE_TTL_MS', 15_000),
        marketWsReconnectMs: env.toPositiveNumber('MARKET_WS_RECONNECT_MS', 3_000),
        marketWsSnapshotWaitMs: env.toPositiveNumber('MARKET_WS_SNAPSHOT_WAIT_MS', 800),
        userWsReconnectMs: env.toPositiveNumber('USER_WS_RECONNECT_MS', 3_000),
        orderConfirmationTimeoutMs: env.toPositiveNumber('ORDER_CONFIRMATION_TIMEOUT_MS', 30_000),
        orderConfirmationPollMs: env.toPositiveNumber('ORDER_CONFIRMATION_POLL_MS', 2_000),
        orderConfirmationBlocks: env.toPositiveNumber('ORDER_CONFIRMATION_BLOCKS', 2),
        liveConfirmTimeoutMs: env.toPositiveNumber('LIVE_CONFIRM_TIMEOUT_MS', 60_000),
        liveReconcileAfterTimeoutMs: env.toPositiveNumber('LIVE_RECONCILE_AFTER_TIMEOUT_MS', 30_000),
        maxSlippageBps: env.toNonNegativeNumber('MAX_SLIPPAGE_BPS', 300),
        maxOrderUsdc: env.toNonNegativeNumber('MAX_ORDER_USDC', 250),
        buyDustResidualMode: env.toChoice('BUY_DUST_RESIDUAL_MODE', ['off', 'defer', 'trim'] as const, 'trim'),
        proxyWallet: runMode === 'live' ? env.requireEnv('PROXY_WALLET') : undefined,
        privateKey: runMode === 'live' ? env.requireEnv('PRIVATE_KEY') : undefined,
        relayerUrl: env.readEnv('RELAYER_URL') || defaultRelayerUrl,
        relayerTxType: env.toChoice('RELAYER_TX_TYPE', ['SAFE', 'PROXY'] as const, 'SAFE'),
        usdcContractAddress: env.readEnv('USDC_CONTRACT_ADDRESS') || defaultUsdcContractAddress,
        ctfContractAddress: env.readEnv('CTF_CONTRACT_ADDRESS') || defaultCtfContractAddress,
        autoRedeemEnabled: env.toBoolean('AUTO_REDEEM_ENABLED', true),
        autoRedeemIntervalMs: env.toPositiveNumber('AUTO_REDEEM_INTERVAL_MS', 30_000),
        autoRedeemMaxConditionsPerRun: env.toPositiveNumber('AUTO_REDEEM_MAX_CONDITIONS_PER_RUN', 8),
    };
};
