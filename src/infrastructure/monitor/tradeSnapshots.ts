import type { AppConfig } from '@config/appConfig';
import type { SourceActivityRecord, UserPositionRecord } from '@infrastructure/polymarket/dto';
import { buildConditionOutcomeKey, computeConditionMergeableSize } from '@shared/conditionMath';
import { normalizeSize, toSafeNumber } from '@shared/math';

export interface TradeSnapshotFields {
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourcePositionPriceAfterTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt: number;
    snapshotStatus: 'COMPLETE' | 'PARTIAL' | 'STALE';
    sourceSnapshotReason: string;
}

interface RollingConditionState {
    outcomeKeys: string[];
    sizes: Map<string, number>;
}

const sortTradesDesc = (trades: SourceActivityRecord[]) =>
    [...trades].sort((left, right) => {
        if (left.timestamp === right.timestamp) {
            return String(right.transactionHash || '').localeCompare(
                String(left.transactionHash || '')
            );
        }

        return right.timestamp - left.timestamp;
    });

export const buildTradeSnapshots = (
    trades: SourceActivityRecord[],
    currentPositions: UserPositionRecord[] | null,
    currentBalance: number | null,
    capturedAt: number,
    config: Pick<AppConfig, 'snapshotStaleAfterMs'>
) => {
    const snapshots = new Map<string, TradeSnapshotFields>();
    if (!Array.isArray(currentPositions) || !Number.isFinite(currentBalance)) {
        for (const trade of trades) {
            const activityKey = trade.activityKey || trade.transactionHash || `${trade.timestamp}`;
            snapshots.set(activityKey, {
                sourceSnapshotCapturedAt: capturedAt,
                snapshotStatus: 'PARTIAL',
                sourceSnapshotReason: '监控轮次缺少源账户余额或持仓，无法生成完整快照',
            });
        }

        return snapshots;
    }

    const outcomeKeysByCondition = new Map<string, Set<string>>();
    const registerOutcome = (
        conditionId: string,
        params: { asset?: string; outcomeIndex?: number; outcome?: string }
    ) => {
        const normalizedConditionId = String(conditionId || '').trim();
        const outcomeKey = buildConditionOutcomeKey(params);
        if (!normalizedConditionId || !outcomeKey) {
            return;
        }

        const existingKeys = outcomeKeysByCondition.get(normalizedConditionId) || new Set<string>();
        existingKeys.add(outcomeKey);
        outcomeKeysByCondition.set(normalizedConditionId, existingKeys);
    };

    currentPositions.forEach((position) => registerOutcome(position.conditionId, position));
    trades.forEach((trade) => registerOutcome(String(trade.conditionId || ''), trade));

    const rollingPositions = new Map(
        currentPositions.map((position) => [
            position.asset,
            {
                size: Math.max(toSafeNumber(position.size), 0),
                price: Math.max(toSafeNumber(position.curPrice, position.avgPrice), 0),
            },
        ])
    );

    const rollingConditionStates = new Map<string, RollingConditionState>();
    const ensureConditionState = (conditionId: string) => {
        const normalizedConditionId = String(conditionId || '').trim();
        const existing = rollingConditionStates.get(normalizedConditionId);
        if (existing) {
            return existing;
        }

        const state: RollingConditionState = {
            outcomeKeys: [...(outcomeKeysByCondition.get(normalizedConditionId) || [])],
            sizes: new Map<string, number>(),
        };
        rollingConditionStates.set(normalizedConditionId, state);
        return state;
    };

    currentPositions.forEach((position) => {
        const state = ensureConditionState(position.conditionId);
        const outcomeKey = buildConditionOutcomeKey(position);
        if (outcomeKey) {
            state.sizes.set(outcomeKey, Math.max(toSafeNumber(position.size), 0));
        }
    });

    let rollingBalance = toSafeNumber(currentBalance);

    for (const trade of sortTradesDesc(trades)) {
        const activityKey = trade.activityKey || trade.transactionHash || `${trade.timestamp}`;
        const conditionState = ensureConditionState(String(trade.conditionId || ''));
        const currentPosition = rollingPositions.get(String(trade.asset || '')) || {
            size: 0,
            price: Math.max(toSafeNumber(trade.price), 0),
        };
        const afterPositionSize = Math.max(toSafeNumber(currentPosition.size), 0);
        const afterPrice = Math.max(toSafeNumber(currentPosition.price, trade.price), 0);
        const tradeSize = Math.max(toSafeNumber(trade.size), 0);
        const tradeUsdc = Math.max(toSafeNumber(trade.usdcSize), 0);
        const normalizedAction = String(trade.side || trade.type || '')
            .trim()
            .toUpperCase();
        const outcomeKey = buildConditionOutcomeKey(trade);
        const afterMergeableSize = computeConditionMergeableSize(
            conditionState.outcomeKeys,
            conditionState.sizes
        );

        let beforePositionSize = afterPositionSize;
        let beforeBalance = rollingBalance;
        let beforeMergeableSize = afterMergeableSize;
        let snapshotStatus: TradeSnapshotFields['snapshotStatus'] =
            capturedAt - toSafeNumber(trade.timestamp) > config.snapshotStaleAfterMs
                ? 'STALE'
                : 'COMPLETE';
        let sourceSnapshotReason =
            snapshotStatus === 'STALE' ? '快照生成时点距离源成交时间过长，已标记为陈旧' : '';

        if (normalizedAction === 'BUY') {
            beforePositionSize = normalizeSize(Math.max(afterPositionSize - tradeSize, 0));
            beforeBalance = rollingBalance + tradeUsdc;
            if (outcomeKey) {
                conditionState.sizes.set(outcomeKey, beforePositionSize);
                beforeMergeableSize = computeConditionMergeableSize(
                    conditionState.outcomeKeys,
                    conditionState.sizes
                );
            }
        } else if (normalizedAction === 'SELL') {
            beforePositionSize = normalizeSize(afterPositionSize + tradeSize);
            beforeBalance = rollingBalance - tradeUsdc;
            if (outcomeKey) {
                conditionState.sizes.set(outcomeKey, beforePositionSize);
                beforeMergeableSize = computeConditionMergeableSize(
                    conditionState.outcomeKeys,
                    conditionState.sizes
                );
            }
        } else if (normalizedAction === 'MERGE') {
            const mergeSize = Math.max(tradeSize, tradeUsdc);
            beforeBalance = rollingBalance - tradeUsdc;
            if (conditionState.outcomeKeys.length < 2) {
                snapshotStatus = 'PARTIAL';
                sourceSnapshotReason =
                    '缺少完整的 condition outcome 快照，无法估算 merge 前后 complete-set 数量';
            } else {
                beforeMergeableSize = normalizeSize(afterMergeableSize + mergeSize);
                for (const conditionOutcomeKey of conditionState.outcomeKeys) {
                    conditionState.sizes.set(
                        conditionOutcomeKey,
                        normalizeSize(
                            Math.max(
                                toSafeNumber(conditionState.sizes.get(conditionOutcomeKey)),
                                0
                            ) + mergeSize
                        )
                    );
                }
            }
        } else if (normalizedAction === 'REDEEM') {
            beforeBalance = rollingBalance - tradeUsdc;
        }

        snapshots.set(activityKey, {
            sourceBalanceAfterTrade: rollingBalance,
            sourceBalanceBeforeTrade: beforeBalance,
            sourcePositionSizeAfterTrade: afterPositionSize,
            sourcePositionSizeBeforeTrade: beforePositionSize,
            sourcePositionPriceAfterTrade: afterPrice,
            sourceConditionMergeableSizeAfterTrade: afterMergeableSize,
            sourceConditionMergeableSizeBeforeTrade: beforeMergeableSize,
            sourceSnapshotCapturedAt: capturedAt,
            snapshotStatus,
            sourceSnapshotReason,
        });

        rollingBalance = beforeBalance;
        rollingPositions.set(String(trade.asset || ''), {
            size: beforePositionSize,
            price: afterPrice,
        });
    }

    return snapshots;
};
