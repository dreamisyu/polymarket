import { ENV } from '../config/env';
import { ExecutionPolicyTrailEntry } from '../interfaces/Execution';
import { UserActivityInterface } from '../interfaces/User';
import { computeBuyTargetUsdc } from './executionPlanning';

const MIN_MARKET_BUY_USDC = 1;
const MAX_ORDER_USDC = ENV.MAX_ORDER_USDC;
const BUY_MIN_TOP_UP_ENABLED = ENV.BUY_MIN_TOP_UP_ENABLED;
const BUY_MIN_TOP_UP_TRIGGER_USDC = ENV.BUY_MIN_TOP_UP_TRIGGER_USDC;
const BUY_MIN_TOP_UP_ALLOWED_BY_ORDER_CAP =
    ENV.MAX_ORDER_USDC <= 0 || ENV.MAX_ORDER_USDC >= MIN_MARKET_BUY_USDC;
const BUY_SIZING_MODE = ENV.BUY_SIZING_MODE;
const BUY_FIRST_ENTRY_TICKET_USDC = ENV.BUY_FIRST_ENTRY_TICKET_USDC;
const BUY_FIRST_ENTRY_SIGNAL_MIN_USDC = ENV.BUY_FIRST_ENTRY_SIGNAL_MIN_USDC;
const BUY_FIRST_ENTRY_TICKET_ALLOWED_BY_ORDER_CAP =
    ENV.MAX_ORDER_USDC <= 0 || ENV.MAX_ORDER_USDC >= BUY_FIRST_ENTRY_TICKET_USDC;
const SIGNAL_IGNORE_BUY_BELOW_USDC = ENV.SIGNAL_IGNORE_BUY_BELOW_USDC;
const SIGNAL_WEAK_SOURCE_BUY_USDC = ENV.SIGNAL_WEAK_SOURCE_BUY_USDC;
const SIGNAL_WEAK_SOURCE_BUY_COUNT = ENV.SIGNAL_WEAK_SOURCE_BUY_COUNT;
const SIGNAL_SINGLE_TRADE_WEAK_USDC = ENV.SIGNAL_SINGLE_TRADE_WEAK_USDC;
const SIGNAL_MIN_SOURCE_BUY_USDC = ENV.SIGNAL_MIN_SOURCE_BUY_USDC;
const SIGNAL_MIN_SOURCE_BUY_COUNT = ENV.SIGNAL_MIN_SOURCE_BUY_COUNT;
const SIGNAL_STRONG_SOURCE_BUY_USDC = ENV.SIGNAL_STRONG_SOURCE_BUY_USDC;
const SIGNAL_STRONG_SOURCE_BUY_COUNT = ENV.SIGNAL_STRONG_SOURCE_BUY_COUNT;
const FOLLOW_WEAK_TICKET_USDC = ENV.FOLLOW_WEAK_TICKET_USDC;
const FOLLOW_FIXED_TICKET_USDC = ENV.FOLLOW_FIXED_TICKET_USDC;
const FOLLOW_STRONG_TICKET_USDC = ENV.FOLLOW_STRONG_TICKET_USDC;
const FOLLOW_MAX_TICKETS_PER_CONDITION = ENV.FOLLOW_MAX_TICKETS_PER_CONDITION;
const FOLLOW_MARKET_SCOPE = ENV.FOLLOW_MARKET_SCOPE;
const EPSILON = 1e-8;

export type SignalBuyTier = '' | 'weak' | 'normal' | 'strong';

const SIGNAL_TIER_POLICY_ID_BY_TIER: Record<Exclude<SignalBuyTier, ''>, string> = {
    weak: 'signal-weak-ticket',
    normal: 'signal-fixed-ticket',
    strong: 'signal-strong-ticket',
};

const SIGNAL_TIER_LABEL_BY_TIER: Record<Exclude<SignalBuyTier, ''>, string> = {
    weak: '弱信号',
    normal: '普通信号',
    strong: '强信号',
};

const SIGNAL_TICKET_USDC_BY_TIER: Record<Exclude<SignalBuyTier, ''>, number> = {
    weak: FOLLOW_WEAK_TICKET_USDC,
    normal: FOLLOW_FIXED_TICKET_USDC,
    strong: FOLLOW_STRONG_TICKET_USDC,
};

export interface DirectBuyIntentEvaluation {
    status: 'EXECUTE' | 'SKIP';
    requestedUsdc: number;
    sourcePrice: number;
    reason: string;
    policyTrail: ExecutionPolicyTrailEntry[];
}

export interface SignalBuyTradeEvaluation {
    status: 'BUFFER' | 'SKIP';
    sourceUsdc: number;
    reason: string;
    policyTrail: ExecutionPolicyTrailEntry[];
}

export interface SignalBufferedBuyEvaluation {
    status: 'EXECUTE' | 'SKIP';
    requestedUsdc: number;
    sourceUsdcTotal: number;
    sourceTradeCount: number;
    tier: SignalBuyTier;
    nextTicketIndex: number;
    reason: string;
    policyTrail: ExecutionPolicyTrailEntry[];
}

const dedupeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()))].filter(Boolean).join('；');

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseClockMinutes = (hourText: string, minuteText: string, meridiemText: string) => {
    const hour = Number.parseInt(hourText, 10);
    const minute = Number.parseInt(minuteText, 10);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return Number.NaN;
    }

    const meridiem = String(meridiemText || '')
        .trim()
        .toLowerCase();
    let normalizedHour = hour % 12;
    if (meridiem === 'pm') {
        normalizedHour += 12;
    }

    return normalizedHour * 60 + minute;
};

const isFiveMinuteUpdownTitle = (normalizedTitle: string) => {
    const match = normalizedTitle.match(
        /(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)\s*et/i
    );
    if (!match) {
        return false;
    }

    const startMinutes = parseClockMinutes(match[1], match[2], match[3]);
    const endMinutes = parseClockMinutes(match[4], match[5], match[6]);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
        return false;
    }

    const diff =
        endMinutes >= startMinutes
            ? endMinutes - startMinutes
            : endMinutes + 24 * 60 - startMinutes;
    return diff === 5;
};

export const isTradeWithinSignalMarketScope = (
    trade: Pick<UserActivityInterface, 'title' | 'slug' | 'eventSlug'>
) => {
    if (FOLLOW_MARKET_SCOPE !== 'crypto_updown_5m') {
        return true;
    }

    const normalizedSlug = String(trade.slug || trade.eventSlug || '')
        .trim()
        .toLowerCase();
    const normalizedTitle = String(trade.title || '')
        .trim()
        .toLowerCase();
    const titleFallbackMatched =
        !normalizedSlug &&
        (normalizedTitle.includes('bitcoin up or down') ||
            normalizedTitle.includes('ethereum up or down')) &&
        isFiveMinuteUpdownTitle(normalizedTitle);

    return (
        normalizedSlug.includes('btc-updown-5m') ||
        normalizedSlug.includes('eth-updown-5m') ||
        titleFallbackMatched
    );
};

export const getSignalMarketScopeSkipReason = () =>
    '当前固定票据策略仅跟 BTC/ETH 5min up/down 市场';

export const getSignalTierPolicyId = (tier: Exclude<SignalBuyTier, ''>) =>
    SIGNAL_TIER_POLICY_ID_BY_TIER[tier];

export const getSignalTierLabel = (tier: SignalBuyTier) =>
    tier ? SIGNAL_TIER_LABEL_BY_TIER[tier] : '';

export const getSignalTicketUsdc = (tier: Exclude<SignalBuyTier, ''>) =>
    SIGNAL_TICKET_USDC_BY_TIER[tier];

const getTriggeredSignalTier = (
    sourceUsdcTotal: number,
    sourceTradeCount: number,
    ticketCountBefore: number,
    maxSingleSourceUsdc: number
): SignalBuyTier => {
    const allowWeakTier = ticketCountBefore <= 0;
    const triggeredStrongSignal =
        sourceUsdcTotal >= SIGNAL_STRONG_SOURCE_BUY_USDC &&
        sourceTradeCount >= SIGNAL_STRONG_SOURCE_BUY_COUNT;
    const triggeredBaseSignal =
        sourceUsdcTotal >= SIGNAL_MIN_SOURCE_BUY_USDC &&
        sourceTradeCount >= SIGNAL_MIN_SOURCE_BUY_COUNT;
    const triggeredWeakSignal =
        allowWeakTier &&
        (maxSingleSourceUsdc >= SIGNAL_SINGLE_TRADE_WEAK_USDC ||
            (sourceUsdcTotal >= SIGNAL_WEAK_SOURCE_BUY_USDC &&
                sourceTradeCount >= SIGNAL_WEAK_SOURCE_BUY_COUNT));

    if (triggeredStrongSignal) {
        return 'strong';
    }

    if (triggeredBaseSignal) {
        return 'normal';
    }

    if (triggeredWeakSignal) {
        return 'weak';
    }

    return '';
};

const clampSignalTicketToOrderCap = (
    requestedUsdc: number
): {
    status: 'EXECUTE' | 'SKIP';
    requestedUsdc: number;
    reason: string;
    policyTrail: ExecutionPolicyTrailEntry[];
} => {
    const normalizedRequestedUsdc = Math.max(toSafeNumber(requestedUsdc), 0);
    if (normalizedRequestedUsdc < MIN_MARKET_BUY_USDC) {
        return {
            status: 'SKIP',
            requestedUsdc: normalizedRequestedUsdc,
            reason: `固定票据 ${normalizedRequestedUsdc.toFixed(4)} USDC 低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`,
            policyTrail: [
                buildTrailEntry(
                    'signal-ticket-under-min',
                    'SKIP',
                    `固定票据 ${normalizedRequestedUsdc.toFixed(4)} USDC 低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`
                ),
            ],
        };
    }

    if (MAX_ORDER_USDC > 0 && normalizedRequestedUsdc > MAX_ORDER_USDC) {
        const cappedUsdc = Math.max(toSafeNumber(MAX_ORDER_USDC), 0);
        if (cappedUsdc < MIN_MARKET_BUY_USDC) {
            return {
                status: 'SKIP',
                requestedUsdc: cappedUsdc,
                reason: `单笔上限 ${cappedUsdc.toFixed(4)} USDC 低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`,
                policyTrail: [
                    buildTrailEntry(
                        'signal-ticket-order-cap',
                        'SKIP',
                        `单笔上限 ${cappedUsdc.toFixed(4)} USDC 低于平台最小下单金额 ${MIN_MARKET_BUY_USDC} USDC`
                    ),
                ],
            };
        }

        return {
            status: 'EXECUTE',
            requestedUsdc: cappedUsdc,
            reason: `固定票据已按单笔风控上限裁剪至 ${cappedUsdc.toFixed(4)} USDC`,
            policyTrail: [
                buildTrailEntry(
                    'signal-ticket-order-cap',
                    'ADJUST',
                    `固定票据已按单笔风控上限裁剪至 ${cappedUsdc.toFixed(4)} USDC`
                ),
            ],
        };
    }

    return {
        status: 'EXECUTE',
        requestedUsdc: normalizedRequestedUsdc,
        reason: '',
        policyTrail: [],
    };
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

export const getTradeSourceUsdc = (
    trade: Pick<UserActivityInterface, 'usdcSize' | 'size' | 'price'>
) => {
    const directUsdc = toSafeNumber(trade.usdcSize, NaN);
    if (Number.isFinite(directUsdc) && directUsdc >= 0) {
        return directUsdc;
    }

    const size = toSafeNumber(trade.size, NaN);
    const price = toSafeNumber(trade.price, NaN);
    if (Number.isFinite(size) && Number.isFinite(price)) {
        return Math.max(size * price, 0);
    }

    return 0;
};

export const evaluateSignalBuyTrade = (
    trade: Pick<
        UserActivityInterface,
        'usdcSize' | 'size' | 'price' | 'title' | 'slug' | 'eventSlug'
    >
): SignalBuyTradeEvaluation => {
    if (!isTradeWithinSignalMarketScope(trade)) {
        const reason = getSignalMarketScopeSkipReason();
        return {
            status: 'SKIP',
            sourceUsdc: getTradeSourceUsdc(trade),
            reason,
            policyTrail: [buildTrailEntry('signal-market-scope', 'SKIP', reason)],
        };
    }

    const sourceUsdc = getTradeSourceUsdc(trade);
    if (sourceUsdc < SIGNAL_IGNORE_BUY_BELOW_USDC) {
        return {
            status: 'SKIP',
            sourceUsdc,
            reason: `源买单 ${sourceUsdc.toFixed(4)} USDC 低于信号过滤阈值 ${SIGNAL_IGNORE_BUY_BELOW_USDC.toFixed(4)} USDC`,
            policyTrail: [
                buildTrailEntry(
                    'signal-ignore-small-buy',
                    'SKIP',
                    `源买单 ${sourceUsdc.toFixed(4)} USDC 低于信号过滤阈值 ${SIGNAL_IGNORE_BUY_BELOW_USDC.toFixed(4)} USDC`
                ),
            ],
        };
    }

    return {
        status: 'BUFFER',
        sourceUsdc,
        reason: '',
        policyTrail: [],
    };
};

export const evaluateBufferedSignalBuy = (params: {
    sourceUsdcTotal: number;
    sourceTradeCount: number;
    maxSingleSourceUsdc?: number;
    existingTicketCount?: number;
    maxTicketsPerCondition?: number;
}): SignalBufferedBuyEvaluation => {
    const sourceUsdcTotal = Math.max(toSafeNumber(params.sourceUsdcTotal), 0);
    const sourceTradeCount = Math.max(Math.trunc(toSafeNumber(params.sourceTradeCount)), 0);
    const maxSingleSourceUsdc = Math.max(toSafeNumber(params.maxSingleSourceUsdc), 0);
    const existingTicketCount = Math.max(Math.trunc(toSafeNumber(params.existingTicketCount)), 0);
    const maxTicketsPerCondition = Math.max(
        Math.trunc(toSafeNumber(params.maxTicketsPerCondition, FOLLOW_MAX_TICKETS_PER_CONDITION)),
        1
    );

    if (existingTicketCount >= maxTicketsPerCondition) {
        return {
            status: 'SKIP',
            requestedUsdc: 0,
            sourceUsdcTotal,
            sourceTradeCount,
            tier: '',
            nextTicketIndex: existingTicketCount + 1,
            reason: `已达到同 condition/outcome 最大跟单次数 ${maxTicketsPerCondition}`,
            policyTrail: [
                buildTrailEntry(
                    'signal-max-tickets',
                    'SKIP',
                    `已达到同 condition/outcome 最大跟单次数 ${maxTicketsPerCondition}`
                ),
            ],
        };
    }

    const tier = getTriggeredSignalTier(
        sourceUsdcTotal,
        sourceTradeCount,
        existingTicketCount,
        maxSingleSourceUsdc
    );
    const nextTicketIndex = existingTicketCount + 1;
    if (!tier) {
        const weakThresholdText =
            existingTicketCount <= 0
                ? `、单笔 ${SIGNAL_SINGLE_TRADE_WEAK_USDC.toFixed(4)} USDC 或累计 ${SIGNAL_WEAK_SOURCE_BUY_USDC.toFixed(4)} USDC / ${SIGNAL_WEAK_SOURCE_BUY_COUNT} 笔`
                : '';
        return {
            status: 'SKIP',
            requestedUsdc: 0,
            sourceUsdcTotal,
            sourceTradeCount,
            tier: '',
            nextTicketIndex,
            reason:
                `累计源买单 ${sourceUsdcTotal.toFixed(4)} USDC / ${sourceTradeCount} 笔，` +
                `未达到触发阈值（第 ${nextTicketIndex} 枪需满足` +
                `${SIGNAL_MIN_SOURCE_BUY_USDC.toFixed(4)} USDC / ${SIGNAL_MIN_SOURCE_BUY_COUNT} 笔` +
                `或 ${SIGNAL_STRONG_SOURCE_BUY_USDC.toFixed(4)} USDC / ${SIGNAL_STRONG_SOURCE_BUY_COUNT} 笔` +
                `${weakThresholdText}）`,
            policyTrail: [
                buildTrailEntry(
                    'signal-tier-threshold',
                    'SKIP',
                    `累计源买单 ${sourceUsdcTotal.toFixed(4)} USDC / ${sourceTradeCount} 笔，未达到触发阈值`
                ),
            ],
        };
    }

    const desiredTicketUsdc = getSignalTicketUsdc(tier);
    const tierLabel = getSignalTierLabel(tier);
    const triggerReason =
        `累计源买单 ${sourceUsdcTotal.toFixed(4)} USDC / ${sourceTradeCount} 笔，` +
        `已触发第 ${nextTicketIndex} 枪${tierLabel}固定票据 ${desiredTicketUsdc.toFixed(4)} USDC`;
    const capped = clampSignalTicketToOrderCap(desiredTicketUsdc);

    if (capped.status === 'SKIP') {
        return {
            status: 'SKIP',
            requestedUsdc: capped.requestedUsdc,
            sourceUsdcTotal,
            sourceTradeCount,
            tier,
            nextTicketIndex,
            reason: dedupeReasons(triggerReason, capped.reason),
            policyTrail: [
                buildTrailEntry(getSignalTierPolicyId(tier), 'SKIP', triggerReason),
                ...capped.policyTrail,
            ],
        };
    }

    return {
        status: 'EXECUTE',
        requestedUsdc: capped.requestedUsdc,
        sourceUsdcTotal,
        sourceTradeCount,
        tier,
        nextTicketIndex,
        reason: dedupeReasons(triggerReason, capped.reason),
        policyTrail: [
            buildTrailEntry(getSignalTierPolicyId(tier), 'ADJUST', triggerReason),
            ...capped.policyTrail,
        ],
    };
};

export const evaluateDirectBuyIntent = (params: {
    trade: UserActivityInterface;
    availableBalance: number;
    hasLocalExposure?: boolean;
    hasPendingBuyExposure?: boolean;
    sourcePositionBeforeTradeSize?: number;
    allowLocalFirstEntryTicket?: boolean;
    bootstrapBudgetRemainingUsdc?: number;
}): DirectBuyIntentEvaluation => {
    const {
        trade,
        availableBalance,
        hasLocalExposure = false,
        hasPendingBuyExposure = false,
        sourcePositionBeforeTradeSize = Number.POSITIVE_INFINITY,
        allowLocalFirstEntryTicket = false,
        bootstrapBudgetRemainingUsdc = Number.POSITIVE_INFINITY,
    } = params;
    const sourcePrice = Math.max(toSafeNumber(trade.price), 0);
    const target = computeBuyTargetUsdc(trade, availableBalance);
    const baseReason = dedupeReasons(target.reason, target.note);
    const isOpeningLocalPosition = !hasLocalExposure && !hasPendingBuyExposure;
    const bootstrapBudgetAllowsTicket =
        bootstrapBudgetRemainingUsdc + EPSILON >= BUY_FIRST_ENTRY_TICKET_USDC;
    const bootstrapBudgetAllowsMinTopUp =
        bootstrapBudgetRemainingUsdc + EPSILON >= MIN_MARKET_BUY_USDC;

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
        isOpeningLocalPosition &&
        bootstrapBudgetAllowsTicket &&
        (allowLocalFirstEntryTicket || isSourceEntryTrade)
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
        availableBalance >= MIN_MARKET_BUY_USDC &&
        (!allowLocalFirstEntryTicket || !isOpeningLocalPosition || bootstrapBudgetAllowsMinTopUp)
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
