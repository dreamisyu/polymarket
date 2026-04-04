import type { Model } from 'mongoose';
import type { AppConfig } from '@config/appConfig';
import type { MonitorSyncResult, SourceTradeEvent } from '@domain';
import { mapSourceActivity } from '@infrastructure/polymarket/mappers/sourceActivityMapper';
import { fetchSourceActivities, fetchUserPositions } from '@infrastructure/polymarket/api';
import { getUsdcBalance } from '@infrastructure/chain/wallet';
import { buildTradeSnapshots } from '@infrastructure/monitor/tradeSnapshots';
import { buildActivityKey } from '@shared/activityKey';
import { toSafeNumber } from '@shared/math';
import { resolveSourceEventBuyFilterRejection } from '@domain/strategy/sourceEventFilters';
import type { SourceActivityRecord } from '@infrastructure/polymarket/dto';
import type { LoggerLike, MonitorGateway } from '@infrastructure/runtime/contracts';
import { getMonitorCursorModel } from '@infrastructure/db/models';

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
    const type = String(trade.type || '')
        .trim()
        .toUpperCase();
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
    private readonly config: AppConfig;
    private readonly logger: LoggerLike;
    private readonly Cursor: Model<MonitorCursorState>;

    constructor(params: { config: AppConfig; logger: LoggerLike }) {
        this.config = params.config;
        this.logger = params.logger;
        this.Cursor = getMonitorCursorModel(params.config.scopeKey);
    }

    async syncOnce(): Promise<MonitorSyncResult> {
        const cursor = await this.Cursor.findOne({
            wallet: this.config.targetWallet,
        }).lean<MonitorCursorState | null>();
        const endTimestamp = Date.now();
        const startTimestamp = Math.max(
            0,
            (cursor?.lastSyncedTimestamp || endTimestamp - this.config.monitorInitialLookbackMs) -
                this.config.monitorOverlapMs
        );
        const fetchedTrades = await this.fetchActivityWindow(startTimestamp, endTimestamp);
        const [positions, balance] = await Promise.all([
            fetchUserPositions(this.config.targetWallet, this.config),
            this.resolveMonitoredUsdcBalance(),
        ]);
        const capturedAt = Date.now();
        const snapshots = buildTradeSnapshots(
            fetchedTrades,
            positions,
            balance,
            capturedAt,
            this.config
        );
        const filterCounts = {
            marketWhitelist: 0,
            minSourceBuyUsdc: 0,
        };
        const rawEvents = fetchedTrades.map((trade) => {
            const event = mapSourceActivity(
                {
                    ...trade,
                    ...snapshots.get(String(trade.activityKey || '')),
                },
                this.config
            );
            event.sourceWallet = this.config.targetWallet;
            return event;
        });
        const events = rawEvents.filter((event) => {
            const rejection = resolveSourceEventBuyFilterRejection(event, this.config);
            if (!rejection) {
                return true;
            }

            if (rejection.code === 'market_whitelist') {
                filterCounts.marketWhitelist += 1;
            } else if (rejection.code === 'min_source_buy_usdc') {
                filterCounts.minSourceBuyUsdc += 1;
            }
            return false;
        });

        const lastTrade = fetchedTrades[fetchedTrades.length - 1];
        await this.Cursor.updateOne(
            { wallet: this.config.targetWallet },
            {
                $set: {
                    wallet: this.config.targetWallet,
                    lastSyncedTimestamp: toSafeNumber(lastTrade?.timestamp, endTimestamp),
                    lastSyncedActivityKey: String(lastTrade?.activityKey || ''),
                },
            },
            { upsert: true }
        );

        this.logger.debug(
            `监控同步完成 fetched=${events.length} raw=${rawEvents.length} filteredByMarketWhitelist=${filterCounts.marketWhitelist} filteredByMinBuy=${filterCounts.minSourceBuyUsdc} start=${startTimestamp} end=${endTimestamp}`
        );

        return {
            events,
            newEvents: events,
            syncedAt: capturedAt,
        };
    }

    private async resolveMonitoredUsdcBalance() {
        if (this.config.runMode === 'paper') {
            // paper 模式不依赖链上 RPC，避免节点连通性导致监控流程退出。
            return 0;
        }

        try {
            return await getUsdcBalance(this.config.targetWallet, this.config);
        } catch (error) {
            if (this.config.strategyKind === 'mirror') {
                throw error;
            }

            this.logger.warn(
                {
                    err: error,
                    wallet: this.config.targetWallet,
                    strategyKind: this.config.strategyKind,
                },
                '监控阶段读取目标钱包 USDC 余额失败，已降级为 PARTIAL 快照'
            );
            return null;
        }
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
                this.config.targetWallet,
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
