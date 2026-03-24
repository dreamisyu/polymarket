import { ENV } from '../../config/env';
import type { RunMode, StrategyKind } from '../domain/types';

export interface RefactorConfig {
    runMode: RunMode;
    strategyKind: StrategyKind;
    sourceWallet: string;
    targetWallet: string;
    scopeKey: string;
    traceId: string;
    traceLabel: string;
    monitorLoopIntervalMs: number;
    strategyLoopIntervalMs: number;
    settlementLoopIntervalMs: number;
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
    maxRetryCount: number;
    retryBackoffMs: number;
    liveConfirmTimeoutMs: number;
    liveReconcileAfterTimeoutMs: number;
    traceInitialBalance: number;
}

const readEnv = (name: string) => {
    const value = process.env[name];
    return typeof value === 'string' ? value.trim() : '';
};

const toPositiveNumber = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeNumber = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeStrategyKind = (): StrategyKind => {
    const explicit = readEnv('STRATEGY_KIND').toLowerCase();
    if (explicit === 'signal' || explicit === 'fixed_amount' || explicit === 'proportional') {
        return explicit;
    }

    if (
        ENV.BUY_SIZING_MODE === 'signal_fixed_ticket' ||
        ENV.BUY_SIZING_MODE === 'condition_pair_overlay'
    ) {
        return 'signal';
    }

    if (ENV.BUY_SIZING_MODE === 'ratio') {
        return 'proportional';
    }

    return 'fixed_amount';
};

const runMode: RunMode = ENV.EXECUTION_MODE === 'trace' ? 'paper' : 'live';
const strategyKind = normalizeStrategyKind();
const traceId = ENV.TRACE_ID;
const traceLabel = ENV.TRACE_LABEL;
const sourceWallet = ENV.USER_ADDRESS;
const targetWallet = runMode === 'paper' ? ENV.TRACE_LABEL : ENV.PROXY_WALLET;
const scopeKey =
    runMode === 'paper'
        ? `${sourceWallet}:paper:${traceId}:${strategyKind}`
        : `${sourceWallet}:live:${ENV.PROXY_WALLET}:${strategyKind}`;

export const refactorConfig: RefactorConfig = {
    runMode,
    strategyKind,
    sourceWallet,
    targetWallet,
    scopeKey,
    traceId,
    traceLabel,
    monitorLoopIntervalMs: toPositiveNumber(readEnv('MONITOR_LOOP_INTERVAL_MS'), ENV.FETCH_INTERVAL),
    strategyLoopIntervalMs: toPositiveNumber(
        readEnv('STRATEGY_LOOP_INTERVAL_MS'),
        runMode === 'paper' ? 500 : ENV.LIVE_EXECUTOR_LOOP_INTERVAL_MS
    ),
    settlementLoopIntervalMs: toPositiveNumber(
        readEnv('SETTLEMENT_LOOP_INTERVAL_MS'),
        ENV.SETTLEMENT_SWEEP_INTERVAL_MS
    ),
    fixedTradeAmountUsdc: toPositiveNumber(
        readEnv('FIXED_TRADE_AMOUNT_USDC'),
        Math.max(ENV.BUY_FIRST_ENTRY_TICKET_USDC, ENV.FOLLOW_FIXED_TICKET_USDC)
    ),
    maxOpenPositions: ENV.FOLLOW_MAX_OPEN_POSITIONS,
    maxActiveExposureUsdc: ENV.FOLLOW_MAX_ACTIVE_EXPOSURE_USDC,
    signalMarketScope: ENV.FOLLOW_MARKET_SCOPE,
    signalWeakThresholdUsdc: toPositiveNumber(
        readEnv('SIGNAL_WEAK_THRESHOLD_USDC'),
        ENV.SIGNAL_SINGLE_TRADE_WEAK_USDC
    ),
    signalNormalThresholdUsdc: toPositiveNumber(
        readEnv('SIGNAL_NORMAL_THRESHOLD_USDC'),
        ENV.SIGNAL_MIN_SOURCE_BUY_USDC
    ),
    signalStrongThresholdUsdc: toPositiveNumber(
        readEnv('SIGNAL_STRONG_THRESHOLD_USDC'),
        ENV.SIGNAL_STRONG_SOURCE_BUY_USDC
    ),
    signalWeakTicketUsdc: toPositiveNumber(readEnv('SIGNAL_WEAK_TICKET_USDC'), ENV.FOLLOW_WEAK_TICKET_USDC),
    signalNormalTicketUsdc: toPositiveNumber(
        readEnv('SIGNAL_NORMAL_TICKET_USDC'),
        ENV.FOLLOW_FIXED_TICKET_USDC
    ),
    signalStrongTicketUsdc: toPositiveNumber(
        readEnv('SIGNAL_STRONG_TICKET_USDC'),
        ENV.FOLLOW_STRONG_TICKET_USDC
    ),
    maxRetryCount: toPositiveNumber(readEnv('WORKFLOW_MAX_RETRY_COUNT'), ENV.RETRY_LIMIT),
    retryBackoffMs: toPositiveNumber(readEnv('WORKFLOW_RETRY_BACKOFF_MS'), 2_000),
    liveConfirmTimeoutMs: toPositiveNumber(
        readEnv('LIVE_CONFIRM_TIMEOUT_MS'),
        ENV.LIVE_CONFIRM_TIMEOUT_MS
    ),
    liveReconcileAfterTimeoutMs: toPositiveNumber(
        readEnv('LIVE_RECONCILE_AFTER_TIMEOUT_MS'),
        ENV.LIVE_RECONCILE_AFTER_TIMEOUT_MS
    ),
    traceInitialBalance: toNonNegativeNumber(
        readEnv('TRACE_INITIAL_BALANCE'),
        ENV.TRACE_INITIAL_BALANCE
    ),
};
