import { SnapshotStatus, UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { buildConditionOutcomeKey, computeConditionMergeableSize } from './conditionPositionMath';

export interface TradeSnapshotFields {
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourcePositionPriceAfterTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt: number;
    snapshotStatus: SnapshotStatus;
    sourceSnapshotReason: string;
}

const EPSILON = 1e-8;
const SNAPSHOT_STALE_AFTER_MS = ENV.SNAPSHOT_STALE_AFTER_MS;

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSize = (value: number) => (Math.abs(value) < EPSILON ? 0 : value);

interface RollingConditionState {
    outcomeKeys: string[];
    sizes: Map<string, number>;
}

const sortTradesDesc = (trades: UserActivityInterface[]) =>
    [...trades].sort((left, right) => {
        if (left.timestamp === right.timestamp) {
            return right.transactionHash.localeCompare(left.transactionHash);
        }

        return right.timestamp - left.timestamp;
    });

const buildTradeSnapshots = (
    trades: UserActivityInterface[],
    currentPositions: UserPositionInterface[] | null,
    currentBalance: number | null,
    capturedAt: number
) => {
    const snapshots = new Map<string, TradeSnapshotFields>();
    if (!Array.isArray(currentPositions) || !Number.isFinite(currentBalance)) {
        for (const trade of trades) {
            const activityKey = trade.activityKey || trade.transactionHash || String(trade._id);
            snapshots.set(activityKey, {
                sourceSnapshotCapturedAt: capturedAt,
                snapshotStatus: 'PARTIAL',
                sourceSnapshotReason: '监控轮次缺少源账户余额或持仓，无法生成完整快照',
            });
        }

        return snapshots;
    }

    const knownOutcomeKeysByCondition = new Map<string, Set<string>>();
    const registerConditionOutcome = (
        conditionId: string,
        params: {
            asset?: string;
            outcomeIndex?: number;
            outcome?: string;
        }
    ) => {
        const normalizedConditionId = String(conditionId || '').trim();
        const outcomeKey = buildConditionOutcomeKey(params);
        if (!normalizedConditionId || !outcomeKey) {
            return;
        }

        const existingKeys =
            knownOutcomeKeysByCondition.get(normalizedConditionId) || new Set<string>();
        existingKeys.add(outcomeKey);
        knownOutcomeKeysByCondition.set(normalizedConditionId, existingKeys);
    };

    for (const position of currentPositions) {
        registerConditionOutcome(position.conditionId, position);
    }

    for (const trade of trades) {
        if (!String(trade.asset || '').trim()) {
            continue;
        }

        registerConditionOutcome(trade.conditionId, trade);
    }

    const rollingPositions = new Map(
        currentPositions.map((position) => [
            position.asset,
            {
                size: Math.max(toSafeNumber(position.size), 0),
                price: Math.max(
                    toSafeNumber(position.curPrice, toSafeNumber(position.avgPrice)),
                    0
                ),
            },
        ])
    );
    const rollingConditionStates = new Map<string, RollingConditionState>();
    const ensureConditionState = (conditionId: string) => {
        const normalizedConditionId = String(conditionId || '').trim();
        const existingState = rollingConditionStates.get(normalizedConditionId);
        if (existingState) {
            return existingState;
        }

        const nextState: RollingConditionState = {
            outcomeKeys: [...(knownOutcomeKeysByCondition.get(normalizedConditionId) || [])],
            sizes: new Map<string, number>(),
        };
        rollingConditionStates.set(normalizedConditionId, nextState);
        return nextState;
    };

    for (const position of currentPositions) {
        const conditionState = ensureConditionState(position.conditionId);
        const outcomeKey = buildConditionOutcomeKey(position);
        if (!outcomeKey) {
            continue;
        }

        conditionState.sizes.set(outcomeKey, Math.max(toSafeNumber(position.size), 0));
    }

    let rollingBalance = toSafeNumber(currentBalance);

    for (const trade of sortTradesDesc(trades)) {
        const activityKey = trade.activityKey || trade.transactionHash || String(trade._id);
        const conditionState = ensureConditionState(trade.conditionId);
        const currentPosition = rollingPositions.get(trade.asset) || {
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
        const afterConditionMergeableSize = computeConditionMergeableSize(
            conditionState.outcomeKeys,
            conditionState.sizes
        );

        let beforePositionSize = afterPositionSize;
        let beforeBalance = rollingBalance;
        let beforeConditionMergeableSize = afterConditionMergeableSize;
        let snapshotStatus: SnapshotStatus =
            capturedAt / 1000 - trade.timestamp / 1000 > SNAPSHOT_STALE_AFTER_MS / 1000
                ? 'STALE'
                : 'COMPLETE';
        let sourceSnapshotReason =
            snapshotStatus === 'STALE' ? '快照生成时点距离源成交时间过长，已标记为陈旧' : '';

        if (normalizedAction === 'BUY') {
            beforePositionSize = normalizeSize(Math.max(afterPositionSize - tradeSize, 0));
            beforeBalance = rollingBalance + tradeUsdc;
            if (outcomeKey) {
                conditionState.sizes.set(outcomeKey, beforePositionSize);
                beforeConditionMergeableSize = computeConditionMergeableSize(
                    conditionState.outcomeKeys,
                    conditionState.sizes
                );
            }
        } else if (normalizedAction === 'SELL') {
            beforePositionSize = normalizeSize(afterPositionSize + tradeSize);
            beforeBalance = rollingBalance - tradeUsdc;
            if (outcomeKey) {
                conditionState.sizes.set(outcomeKey, beforePositionSize);
                beforeConditionMergeableSize = computeConditionMergeableSize(
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
                beforeConditionMergeableSize = normalizeSize(
                    afterConditionMergeableSize + mergeSize
                );
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
            sourceConditionMergeableSizeAfterTrade: afterConditionMergeableSize,
            sourceConditionMergeableSizeBeforeTrade: beforeConditionMergeableSize,
            sourceSnapshotCapturedAt: capturedAt,
            snapshotStatus,
            sourceSnapshotReason,
        });

        rollingBalance = beforeBalance;
        rollingPositions.set(trade.asset, {
            size: beforePositionSize,
            price: afterPrice,
        });
    }

    return snapshots;
};

export default buildTradeSnapshots;
