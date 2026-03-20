import { ENV } from '../config/env';
import { ExecutionPolicyTrailEntry } from '../interfaces/Execution';
import { UserActivityInterface } from '../interfaces/User';
import { computeBuyTargetUsdc } from './executionPlanning';

const MIN_MARKET_BUY_USDC = 1;
const BUY_MIN_TOP_UP_ENABLED = ENV.BUY_MIN_TOP_UP_ENABLED;
const BUY_MIN_TOP_UP_TRIGGER_USDC = ENV.BUY_MIN_TOP_UP_TRIGGER_USDC;
const BUY_MIN_TOP_UP_ALLOWED_BY_ORDER_CAP =
    ENV.MAX_ORDER_USDC <= 0 || ENV.MAX_ORDER_USDC >= MIN_MARKET_BUY_USDC;
const BUY_SIZING_MODE = ENV.BUY_SIZING_MODE;
const BUY_FIRST_ENTRY_TICKET_USDC = ENV.BUY_FIRST_ENTRY_TICKET_USDC;
const BUY_FIRST_ENTRY_SIGNAL_MIN_USDC = ENV.BUY_FIRST_ENTRY_SIGNAL_MIN_USDC;
const BUY_FIRST_ENTRY_TICKET_ALLOWED_BY_ORDER_CAP =
    ENV.MAX_ORDER_USDC <= 0 || ENV.MAX_ORDER_USDC >= BUY_FIRST_ENTRY_TICKET_USDC;
const EPSILON = 1e-8;

export interface DirectBuyIntentEvaluation {
    status: 'EXECUTE' | 'SKIP';
    requestedUsdc: number;
    sourcePrice: number;
    reason: string;
    policyTrail: ExecutionPolicyTrailEntry[];
}

const dedupeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()))].filter(Boolean).join('；');

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const buildTrailEntry = (
    policyId: string,
    action: ExecutionPolicyTrailEntry['action'],
    reason: string
): ExecutionPolicyTrailEntry => ({
    policyId,
    action,
    reason,
    timestamp: Date.now(),
});

export const sortTradesAsc = (trades: UserActivityInterface[]) =>
    [...trades].sort((left, right) =>
        left.timestamp === right.timestamp
            ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
            : left.timestamp - right.timestamp
    );

export const evaluateDirectBuyIntent = (params: {
    trade: UserActivityInterface;
    availableBalance: number;
    hasLocalExposure?: boolean;
    hasPendingBuyExposure?: boolean;
    sourcePositionBeforeTradeSize?: number;
}): DirectBuyIntentEvaluation => {
    const {
        trade,
        availableBalance,
        hasLocalExposure = false,
        hasPendingBuyExposure = false,
        sourcePositionBeforeTradeSize = Number.POSITIVE_INFINITY,
    } = params;
    const sourcePrice = Math.max(toSafeNumber(trade.price), 0);
    const target = computeBuyTargetUsdc(trade, availableBalance);
    const baseReason = dedupeReasons(target.reason, target.note);

    if (target.status !== 'READY') {
        return {
            status: 'SKIP',
            requestedUsdc: 0,
            sourcePrice,
            reason: baseReason || '裁剪后可用下单金额为 0',
            policyTrail: [
                buildTrailEntry(
                    'cash-ratio-buy-sizing',
                    'SKIP',
                    baseReason || '裁剪后可用下单金额为 0'
                ),
            ],
        };
    }

    if (target.requestedUsdc >= MIN_MARKET_BUY_USDC) {
        return {
            status: 'EXECUTE',
            requestedUsdc: target.requestedUsdc,
            sourcePrice,
            reason: baseReason,
            policyTrail: [],
        };
    }

    const isSourceEntryTrade = Math.max(toSafeNumber(sourcePositionBeforeTradeSize), 0) <= EPSILON;
    if (
        BUY_SIZING_MODE === 'first_entry_ticket' &&
        BUY_FIRST_ENTRY_TICKET_ALLOWED_BY_ORDER_CAP &&
        BUY_FIRST_ENTRY_TICKET_USDC >= MIN_MARKET_BUY_USDC &&
        target.requestedUsdc >= BUY_FIRST_ENTRY_SIGNAL_MIN_USDC &&
        availableBalance >= BUY_FIRST_ENTRY_TICKET_USDC &&
        !hasLocalExposure &&
        !hasPendingBuyExposure &&
        isSourceEntryTrade
    ) {
        const ticketReason = dedupeReasons(
            baseReason,
            `已按首单定额补齐到 ${BUY_FIRST_ENTRY_TICKET_USDC.toFixed(4)} USDC`
        );
        return {
            status: 'EXECUTE',
            requestedUsdc: BUY_FIRST_ENTRY_TICKET_USDC,
            sourcePrice,
            reason: ticketReason,
            policyTrail: [
                buildTrailEntry(
                    'first-entry-ticket',
                    'ADJUST',
                    `首笔开仓比例金额 ${target.requestedUsdc.toFixed(4)} USDC，已提升到 ${BUY_FIRST_ENTRY_TICKET_USDC.toFixed(4)} USDC`
                ),
            ],
        };
    }

    if (
        BUY_MIN_TOP_UP_ENABLED &&
        BUY_MIN_TOP_UP_ALLOWED_BY_ORDER_CAP &&
        target.requestedUsdc >= BUY_MIN_TOP_UP_TRIGGER_USDC &&
        availableBalance >= MIN_MARKET_BUY_USDC
    ) {
        const topUpReason = dedupeReasons(baseReason, '已按最小买单门槛补齐到 1 USDC');
        return {
            status: 'EXECUTE',
            requestedUsdc: MIN_MARKET_BUY_USDC,
            sourcePrice,
            reason: topUpReason,
            policyTrail: [
                buildTrailEntry(
                    'min-buy-top-up',
                    'ADJUST',
                    `买单金额 ${target.requestedUsdc.toFixed(4)} USDC，已补齐到 1 USDC`
                ),
            ],
        };
    }

    const skipReason = dedupeReasons(
        baseReason,
        `买单金额低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`
    );
    return {
        status: 'SKIP',
        requestedUsdc: target.requestedUsdc,
        sourcePrice,
        reason: skipReason,
        policyTrail: [
            buildTrailEntry(
                'sub-min-buy-skip',
                'SKIP',
                `买单金额 ${target.requestedUsdc.toFixed(4)} USDC，未达到 ${MIN_MARKET_BUY_USDC} USDC`
            ),
        ],
    };
};
