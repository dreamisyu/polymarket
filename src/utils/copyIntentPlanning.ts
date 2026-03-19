import { ENV } from '../config/env';
import { ExecutionPolicyTrailEntry } from '../interfaces/Execution';
import { UserActivityInterface } from '../interfaces/User';
import { computeBuyTargetUsdc } from './executionPlanning';

const MIN_MARKET_BUY_USDC = 1;
const BUY_SOURCE_MERGE_WINDOW_MS = ENV.BUY_SOURCE_MERGE_WINDOW_MS;
const BUY_INTENT_BUFFER_MAX_MS = ENV.BUY_INTENT_BUFFER_MAX_MS;
const BUY_MIN_TOP_UP_ENABLED = ENV.BUY_MIN_TOP_UP_ENABLED;
const BUY_MIN_TOP_UP_TRIGGER_USDC = ENV.BUY_MIN_TOP_UP_TRIGGER_USDC;

type BuyBufferDecisionStatus = 'BUFFER' | 'EXECUTE' | 'SKIP';

export interface BuyBufferEvaluation {
    status: BuyBufferDecisionStatus;
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

export const buildBuyBufferKey = (trade: Pick<UserActivityInterface, 'asset'>) =>
    `buy:${String(trade.asset || '').trim()}`;

export const buildBuyBufferFlushAfter = (timestamp: number) => timestamp + BUY_SOURCE_MERGE_WINDOW_MS;

export const buildBuyBufferExpireAt = (timestamp: number) => timestamp + BUY_INTENT_BUFFER_MAX_MS;

export const sortTradesAsc = (trades: UserActivityInterface[]) =>
    [...trades].sort((left, right) =>
        left.timestamp === right.timestamp
            ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
            : left.timestamp - right.timestamp
    );

export const evaluateBuyBuffer = (params: {
    trades: UserActivityInterface[];
    availableBalance: number;
    expireAt: number;
    now: number;
}): BuyBufferEvaluation => {
    const { trades, availableBalance, expireAt, now } = params;
    const policyTrail: ExecutionPolicyTrailEntry[] = [];
    const sortedTrades = sortTradesAsc(trades);

    if (sortedTrades.length > 1) {
        policyTrail.push(
            buildTrailEntry(
                'source-trade-merge',
                'ADJUST',
                `已合并 ${sortedTrades.length} 笔同资产源买单`
            )
        );
    }

    let virtualBalance = Math.max(toSafeNumber(availableBalance), 0);
    let requestedUsdc = 0;
    let sourcePrice = 0;
    let note = '';

    for (const trade of sortedTrades) {
        const target = computeBuyTargetUsdc(
            trade,
            virtualBalance,
            Math.max(toSafeNumber(trade.sourceBalanceAfterTrade), 0)
        );
        if (target.status !== 'READY') {
            note = dedupeReasons(note, target.reason, target.note);
            continue;
        }

        requestedUsdc += target.requestedUsdc;
        virtualBalance = Math.max(virtualBalance - target.requestedUsdc, 0);
        sourcePrice = Math.max(sourcePrice, Math.max(toSafeNumber(trade.price), 0));
        note = dedupeReasons(note, target.note);
    }

    if (requestedUsdc >= MIN_MARKET_BUY_USDC) {
        return {
            status: 'EXECUTE',
            requestedUsdc,
            sourcePrice,
            reason: note,
            policyTrail,
        };
    }

    if (
        BUY_MIN_TOP_UP_ENABLED &&
        requestedUsdc > 0 &&
        requestedUsdc >= BUY_MIN_TOP_UP_TRIGGER_USDC &&
        availableBalance >= MIN_MARKET_BUY_USDC
    ) {
        policyTrail.push(
            buildTrailEntry(
                'min-buy-top-up',
                'ADJUST',
                `累计买单金额 ${requestedUsdc.toFixed(4)} USDC，已补齐到 1 USDC`
            )
        );
        return {
            status: 'EXECUTE',
            requestedUsdc: MIN_MARKET_BUY_USDC,
            sourcePrice,
            reason: dedupeReasons(note, '已按最小买单门槛补齐到 1 USDC'),
            policyTrail,
        };
    }

    if (expireAt > 0 && now >= expireAt) {
        policyTrail.push(
            buildTrailEntry(
                'sub-min-buy-accumulator',
                'SKIP',
                `累计窗口内仍未达到 ${MIN_MARKET_BUY_USDC} USDC，已放弃执行`
            )
        );
        return {
            status: 'SKIP',
            requestedUsdc,
            sourcePrice,
            reason: dedupeReasons(
                note,
                `累计窗口内剩余买单金额低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`
            ),
            policyTrail,
        };
    }

    policyTrail.push(
        buildTrailEntry(
            'sub-min-buy-accumulator',
            'DEFER',
            `累计买单金额 ${requestedUsdc.toFixed(4)} USDC，继续等待后续源买单`
        )
    );
    return {
        status: 'BUFFER',
        requestedUsdc,
        sourcePrice,
        reason: dedupeReasons(
            note,
            `累计买单金额 ${requestedUsdc.toFixed(4)} USDC，暂不执行并继续等待`
        ),
        policyTrail,
    };
};
