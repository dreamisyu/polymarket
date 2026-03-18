import { SnapshotStatus, UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';

export interface TradeSnapshotFields {
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourcePositionPriceAfterTrade?: number;
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
    let rollingBalance = toSafeNumber(currentBalance);

    for (const trade of sortTradesDesc(trades)) {
        const activityKey = trade.activityKey || trade.transactionHash || String(trade._id);
        const currentPosition = rollingPositions.get(trade.asset) || {
            size: 0,
            price: Math.max(toSafeNumber(trade.price), 0),
        };
        const afterPositionSize = Math.max(toSafeNumber(currentPosition.size), 0);
        const afterPrice = Math.max(toSafeNumber(currentPosition.price, trade.price), 0);
        const tradeSize = Math.max(toSafeNumber(trade.size), 0);
        const tradeUsdc = Math.max(toSafeNumber(trade.usdcSize), 0);
        const tradeSide = String(trade.side || '').toUpperCase();

        let beforePositionSize = afterPositionSize;
        let beforeBalance = rollingBalance;

        if (tradeSide === 'BUY') {
            beforePositionSize = normalizeSize(Math.max(afterPositionSize - tradeSize, 0));
            beforeBalance = rollingBalance + tradeUsdc;
        } else if (tradeSide === 'SELL' || tradeSide === 'MERGE') {
            beforePositionSize = normalizeSize(afterPositionSize + tradeSize);
            beforeBalance = rollingBalance - tradeUsdc;
        }

        const snapshotStatus: SnapshotStatus =
            capturedAt - trade.timestamp > SNAPSHOT_STALE_AFTER_MS ? 'STALE' : 'COMPLETE';
        snapshots.set(activityKey, {
            sourceBalanceAfterTrade: rollingBalance,
            sourceBalanceBeforeTrade: beforeBalance,
            sourcePositionSizeAfterTrade: afterPositionSize,
            sourcePositionSizeBeforeTrade: beforePositionSize,
            sourcePositionPriceAfterTrade: afterPrice,
            sourceSnapshotCapturedAt: capturedAt,
            snapshotStatus,
            sourceSnapshotReason:
                snapshotStatus === 'STALE' ? '快照生成时点距离源成交时间过长，已标记为陈旧' : '',
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
