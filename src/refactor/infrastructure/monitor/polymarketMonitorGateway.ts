import type { Model } from 'mongoose';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type { MonitorSyncResult, SourceTradeEvent } from '../../domain';
import { mapSourceActivity } from '../polymarket/mappers/sourceActivityMapper';
import { fetchSourceActivities, fetchUserPositions } from '../polymarket/api';
import { getUsdcBalance } from '../chain/wallet';
import { buildTradeSnapshots } from '../../utils/snapshots';
import { buildActivityKey } from '../../utils/activityKey';
import { toSafeNumber } from '../../utils/math';
import type { SourceActivityRecord } from '../polymarket/dto';
import type { LoggerLike, MonitorGateway } from '../runtime/contracts';
import { getMonitorCursorModel } from '../db/models';

interface MonitorCursorState {
    wallet: string;
    lastSyncedTimestamp: number;
    lastSyncedActivityKey: string;
}

const trackedTypes = new Set(['TRADE', 'MERGE', 'REDEEM']);
const millisecondThreshold = 1_000_000_000_000;

const normalizeTimestamp = (rawTimestamp: number) => {
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
        return null;
    }

    const parsed = Math.trunc(rawTimestamp);
    return parsed < millisecondThreshold ? parsed * 1000 : parsed;
};

const normalizeTrade = (trade: SourceActivityRecord): SourceActivityRecord | null => {
    const timestamp = normalizeTimestamp(Number(trade.timestamp));
    const type = String(trade.type || '').trim().toUpperCase();
    if (!timestamp || !trackedTypes.has(type)) {
        return null;
    }

    const normalizedTrade: SourceActivityRecord = {
        ...trade,
        timestamp,
        type,
        transactionHash: String(trade.transactionHash || '').trim(),
        activityKey: String(trade.activityKey || '').trim() || buildActivityKey(trade),
    };
    return normalizedTrade;
};

const dedupeByActivityKey = (trades: SourceActivityRecord[]) => {
    const tradeMap = new Map<string, SourceActivityRecord>();
    for (const trade of trades) {
        if (!trade.activityKey) {
            continue;
        }
        tradeMap.set(trade.activityKey, trade);
    }

    return [...tradeMap.values()].sort((left, right) =>
        left.timestamp === right.timestamp
            ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
            : left.timestamp - right.timestamp
    );
};

export class PolymarketMonitorGateway implements MonitorGateway {
    private readonly config: RuntimeConfig;
    private readonly logger: LoggerLike;
    private readonly Cursor: Model<MonitorCursorState>;

    constructor(params: { config: RuntimeConfig; logger: LoggerLike }) {
        this.config = params.config;
        this.logger = params.logger;
        this.Cursor = getMonitorCursorModel(params.config.scopeKey);
    }

    async syncOnce(): Promise<MonitorSyncResult> {
        const cursor = await this.Cursor.findOne({ wallet: this.config.sourceWallet }).lean<MonitorCursorState | null>();
        const endTimestamp = Date.now();
        const startTimestamp = Math.max(
            0,
            (cursor?.lastSyncedTimestamp || endTimestamp - this.config.monitorInitialLookbackMs) - this.config.monitorOverlapMs
        );
        const fetchedTrades = await this.fetchActivityWindow(startTimestamp, endTimestamp);
        const [positions, balance] = await Promise.all([
            fetchUserPositions(this.config.sourceWallet, this.config),
            getUsdcBalance(this.config.sourceWallet, this.config),
        ]);
        const capturedAt = Date.now();
        const snapshots = buildTradeSnapshots(fetchedTrades, positions, balance, capturedAt, this.config);
        const events = fetchedTrades.map((trade) => {
            const event = mapSourceActivity(
                {
                    ...trade,
                    ...snapshots.get(String(trade.activityKey || '')),
                },
                this.config
            );
            event.sourceWallet = this.config.sourceWallet;
            return event;
        });

        const lastTrade = fetchedTrades[fetchedTrades.length - 1];
        await this.Cursor.updateOne(
            { wallet: this.config.sourceWallet },
            {
                $set: {
                    wallet: this.config.sourceWallet,
                    lastSyncedTimestamp: toSafeNumber(lastTrade?.timestamp, endTimestamp),
                    lastSyncedActivityKey: String(lastTrade?.activityKey || ''),
                },
            },
            { upsert: true }
        );

        if (events.length > 0) {
            this.logger.debug(`监控同步完成 fetched=${events.length} start=${startTimestamp} end=${endTimestamp}`);
        }

        return {
            events,
            newEvents: events,
            syncedAt: capturedAt,
        };
    }

    private async fetchActivityWindow(startTimestamp: number, endTimestamp: number) {
        const normalizedStart = Math.trunc(startTimestamp / 1000);
        const normalizedEnd = Math.trunc(endTimestamp / 1000);
        let cursor = normalizedStart;
        const tradeMap = new Map<string, SourceActivityRecord>();

        while (cursor <= normalizedEnd) {
            const activitiesRaw = await fetchSourceActivities(
                {
                    start: cursor,
                    end: normalizedEnd,
                    limit: this.config.activitySyncLimit,
                },
                this.config
            );
            if (!Array.isArray(activitiesRaw)) {
                this.logger.warn('活动接口不可用，本轮监控返回空结果');
                return [] as SourceActivityRecord[];
            }

            const normalizedTrades = dedupeByActivityKey(
                activitiesRaw
                    .map(normalizeTrade)
                    .filter((trade): trade is SourceActivityRecord => trade !== null)
            );
            normalizedTrades.forEach((trade) => {
                tradeMap.set(String(trade.activityKey || ''), trade);
            });

            if (activitiesRaw.length < this.config.activitySyncLimit) {
                break;
            }

            const lastRawTimestamp = [...activitiesRaw]
                .reverse()
                .map((activity) => Math.trunc(toSafeNumber(activity.timestamp) / 1000))
                .find((timestamp) => timestamp > 0);
            if (!lastRawTimestamp || lastRawTimestamp <= cursor) {
                break;
            }

            cursor = lastRawTimestamp + 1;
        }

        return [...tradeMap.values()].sort((left, right) =>
            left.timestamp === right.timestamp
                ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
                : left.timestamp - right.timestamp
        );
    }
}
