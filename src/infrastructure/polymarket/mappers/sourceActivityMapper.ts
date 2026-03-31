import type { AppConfig } from '@config/appConfig';
import type { SourceTradeEvent, TradeAction } from '@domain';
import type { SourceActivityRecord } from '@infrastructure/polymarket/dto';
import { buildActivityKey } from '@shared/activityKey';
import { resolveExecutionIntent, resolveTradeAction } from '@shared/executionSemantics';
import { toSafeNumber } from '@shared/math';

const normalizeTradeAction = (trade: SourceActivityRecord): TradeAction => {
    const tradeAction = resolveTradeAction(trade).toLowerCase();
    if (tradeAction === 'buy' || tradeAction === 'sell') {
        return tradeAction;
    }

    const type = String(trade.type || '')
        .trim()
        .toUpperCase();
    if (type === 'MERGE') {
        return 'merge';
    }

    return 'redeem';
};

export const mapSourceActivity = (
    trade: SourceActivityRecord,
    config: Pick<AppConfig, 'runMode'>
): SourceTradeEvent => ({
    sourceWallet: String(trade.proxyWallet || '').trim(),
    activityKey: String(trade.activityKey || '').trim() || buildActivityKey(trade),
    timestamp: toSafeNumber(trade.timestamp, Date.now()),
    type: String(trade.type || '')
        .trim()
        .toUpperCase(),
    side: String(trade.side || '')
        .trim()
        .toUpperCase(),
    action: normalizeTradeAction(trade),
    transactionHash: String(trade.transactionHash || '').trim(),
    conditionId: String(trade.conditionId || '').trim(),
    asset: String(trade.asset || '').trim(),
    outcome: String(trade.outcome || '').trim(),
    outcomeIndex: toSafeNumber(trade.outcomeIndex),
    title: String(trade.title || '').trim(),
    slug: String(trade.slug || '').trim(),
    eventSlug: String(trade.eventSlug || '').trim(),
    price: toSafeNumber(trade.price),
    size: toSafeNumber(trade.size),
    usdcSize: toSafeNumber(trade.usdcSize),
    executionIntent: resolveExecutionIntent(trade, config.runMode),
    sourceBalanceAfterTrade: trade.sourceBalanceAfterTrade,
    sourceBalanceBeforeTrade: trade.sourceBalanceBeforeTrade,
    sourcePositionSizeAfterTrade: trade.sourcePositionSizeAfterTrade,
    sourcePositionSizeBeforeTrade: trade.sourcePositionSizeBeforeTrade,
    sourceConditionMergeableSizeAfterTrade: trade.sourceConditionMergeableSizeAfterTrade,
    sourceConditionMergeableSizeBeforeTrade: trade.sourceConditionMergeableSizeBeforeTrade,
    sourceSnapshotCapturedAt: trade.sourceSnapshotCapturedAt,
    snapshotStatus: trade.snapshotStatus,
    sourceSnapshotReason: trade.sourceSnapshotReason,
    raw: {
        sourceActivityKeys: trade.sourceActivityKeys,
        sourceTransactionHashes: trade.sourceTransactionHashes,
        sourceTradeCount: trade.sourceTradeCount,
        sourceStartedAt: trade.sourceStartedAt,
        sourceEndedAt: trade.sourceEndedAt,
    },
});
