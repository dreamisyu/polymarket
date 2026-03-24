import type { UserActivityInterface } from '../../interfaces/User';
import { ENV } from '../../config/env';
import buildActivityKey from '../../utils/buildActivityKey';
import { resolveExecutionIntent, resolveTradeAction } from '../../utils/executionSemantics';
import type { SourceTradeEvent, TradeAction } from '../domain/types';

const normalizeTradeAction = (trade: UserActivityInterface): TradeAction => {
    const tradeAction = resolveTradeAction(trade).toLowerCase();
    if (tradeAction === 'buy' || tradeAction === 'sell') {
        return tradeAction;
    }

    const type = String(trade.type || '').trim().toUpperCase();
    if (type === 'MERGE') {
        return 'merge';
    }

    return 'redeem';
};

export const mapSourceActivity = (trade: UserActivityInterface): SourceTradeEvent => ({
    sourceWallet: String(trade.proxyWallet || '').trim(),
    activityKey: String(trade.activityKey || '').trim() || buildActivityKey(trade),
    timestamp: Number(trade.timestamp) || Date.now(),
    type: String(trade.type || '').trim().toUpperCase(),
    side: String(trade.side || '').trim().toUpperCase(),
    action: normalizeTradeAction(trade),
    transactionHash: String(trade.transactionHash || '').trim(),
    conditionId: String(trade.conditionId || '').trim(),
    asset: String(trade.asset || '').trim(),
    outcome: String(trade.outcome || '').trim(),
    outcomeIndex: Number(trade.outcomeIndex) || 0,
    title: String(trade.title || '').trim(),
    slug: String(trade.slug || '').trim(),
    eventSlug: String(trade.eventSlug || '').trim(),
    price: Number(trade.price) || 0,
    size: Number(trade.size) || 0,
    usdcSize: Number(trade.usdcSize) || 0,
    executionIntent: resolveExecutionIntent(trade, ENV.EXECUTION_MODE),
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
    },
});
