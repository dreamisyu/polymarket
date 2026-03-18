import { ENV } from '../config/env';
import {
    BotExecutionStatus,
    ExecutionIntent,
    UserActivityInterface,
    UserActivitySyncStateInterface,
    UserPositionInterface,
} from '../interfaces/User';
import { getUserActivityModel, getUserActivitySyncStateModel } from '../models/userHistory';
import buildTradeSnapshots, { TradeSnapshotFields } from '../utils/buildTradeSnapshots';
import buildActivityKey from '../utils/buildActivityKey';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';

const USER_ADDRESS = ENV.USER_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const ACTIVITY_SYNC_LIMIT = ENV.ACTIVITY_SYNC_LIMIT;
const ACTIVITY_SYNC_OVERLAP_MS = ENV.ACTIVITY_SYNC_OVERLAP_MS;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;
const TRACKED_ACTIVITY_TYPES = new Set(['TRADE', 'MERGE', 'REDEEM']);
const SOURCE_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}&sizeThreshold=0`;
const INITIAL_SYNC_LOOKBACK_MS = TOO_OLD_TIMESTAMP * 60 * 60 * 1000;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserActivitySyncState = getUserActivitySyncStateModel(USER_ADDRESS);

const normalizeTimestamp = (rawTimestamp: number): number | null => {
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
        return null;
    }

    const parsedTimestamp = Math.trunc(rawTimestamp);
    return parsedTimestamp < MILLISECOND_TIMESTAMP_THRESHOLD
        ? parsedTimestamp * 1000
        : parsedTimestamp;
};

const resolveExecutionIntent = (trade: UserActivityInterface): ExecutionIntent =>
    String(trade.type || '').toUpperCase() === 'TRADE' ? 'EXECUTE' : 'SYNC_ONLY';

const getDefaultBotStatus = (trade: UserActivityInterface): BotExecutionStatus => {
    if (resolveExecutionIntent(trade) === 'SYNC_ONLY') {
        return 'SKIPPED';
    }

    if (trade.botStatus) {
        return trade.botStatus;
    }

    return trade.bot ? 'CONFIRMED' : 'PENDING';
};

const hasCompleteSnapshot = (trade: UserActivityInterface) =>
    trade.snapshotStatus === 'COMPLETE' &&
    Number.isFinite(trade.sourceBalanceAfterTrade) &&
    Number.isFinite(trade.sourceBalanceBeforeTrade) &&
    Number.isFinite(trade.sourcePositionSizeAfterTrade) &&
    Number.isFinite(trade.sourcePositionSizeBeforeTrade);

const normalizeTrade = (trade: UserActivityInterface): UserActivityInterface | null => {
    const baseTrade =
        typeof (trade as { toObject?: () => UserActivityInterface }).toObject === 'function'
            ? (trade as { toObject: () => UserActivityInterface }).toObject()
            : trade;
    const normalizedTimestamp = normalizeTimestamp(Number(baseTrade.timestamp));
    const transactionHash = String(baseTrade.transactionHash || '').trim();
    const type = String(baseTrade.type || '')
        .trim()
        .toUpperCase();

    if (normalizedTimestamp === null) {
        console.warn(`跳过时间戳无效的活动: ${transactionHash || 'unknown-hash'}`);
        return null;
    }

    if (!TRACKED_ACTIVITY_TYPES.has(type)) {
        return null;
    }

    const normalizedTrade = {
        ...baseTrade,
        type,
        transactionHash,
        timestamp: normalizedTimestamp,
    };

    return {
        ...normalizedTrade,
        activityKey: buildActivityKey(normalizedTrade),
    };
};

const dedupeTradesByActivityKey = (trades: UserActivityInterface[]) => {
    const tradeMap = new Map<string, UserActivityInterface>();

    for (const trade of trades) {
        if (!trade.activityKey) {
            continue;
        }

        tradeMap.set(trade.activityKey, trade);
    }

    return [...tradeMap.values()];
};

const prepareSnapshotData = (
    trade: UserActivityInterface,
    snapshots: Map<string, TradeSnapshotFields>,
    capturedAt: number
) => ({
    ...(snapshots.get(trade.activityKey || '') || {
        sourceSnapshotCapturedAt: capturedAt,
        snapshotStatus: 'PARTIAL' as const,
        sourceSnapshotReason: '监控轮次未生成该笔活动的快照',
    }),
});

const shouldUpdateSnapshot = (
    trade: UserActivityInterface,
    snapshotData: TradeSnapshotFields | undefined
) => {
    if (!snapshotData) {
        return false;
    }

    if (!trade.snapshotStatus || trade.snapshotStatus !== 'COMPLETE') {
        return true;
    }

    return snapshotData.snapshotStatus === 'COMPLETE';
};

const fetchActivityWindow = async (startTimestamp: number, endTimestamp: number) => {
    const tradeMap = new Map<string, UserActivityInterface>();
    let cursor = startTimestamp;

    while (cursor <= endTimestamp) {
        const params = new URLSearchParams({
            user: USER_ADDRESS,
            start: String(cursor),
            end: String(endTimestamp),
            limit: String(ACTIVITY_SYNC_LIMIT),
            sortDirection: 'ASC',
        });
        const activitiesRaw = await fetchData<UserActivityInterface[]>(
            `https://data-api.polymarket.com/activity?${params.toString()}`
        );

        if (!Array.isArray(activitiesRaw)) {
            console.warn('活动接口暂不可用，跳过本轮抓取');
            return [];
        }

        const normalizedTrades = dedupeTradesByActivityKey(
            activitiesRaw
                .map(normalizeTrade)
                .filter((trade): trade is UserActivityInterface => trade !== null)
                .sort((left, right) =>
                    left.timestamp === right.timestamp
                        ? String(left.activityKey || '').localeCompare(
                              String(right.activityKey || '')
                          )
                        : left.timestamp - right.timestamp
                )
        );

        for (const trade of normalizedTrades) {
            if (!trade.activityKey) {
                continue;
            }

            tradeMap.set(trade.activityKey, trade);
        }

        if (activitiesRaw.length < ACTIVITY_SYNC_LIMIT) {
            break;
        }

        const lastRawTimestamp = [...activitiesRaw]
            .reverse()
            .map((activity) => normalizeTimestamp(Number(activity.timestamp)))
            .find((timestamp): timestamp is number => timestamp !== null);
        if (!lastRawTimestamp) {
            break;
        }

        const nextCursor = lastRawTimestamp + 1;
        if (nextCursor <= cursor) {
            console.warn('活动分页游标未能前进，提前结束本轮抓取以避免死循环');
            break;
        }

        cursor = nextCursor;
    }

    return [...tradeMap.values()].sort((left, right) =>
        left.timestamp === right.timestamp
            ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
            : left.timestamp - right.timestamp
    );
};

const readSyncState = async (): Promise<UserActivitySyncStateInterface | null> =>
    (await UserActivitySyncState.findOne({
        walletAddress: USER_ADDRESS,
    }).exec()) as UserActivitySyncStateInterface | null;

const writeSyncState = async (lastTrade: UserActivityInterface | null, endTimestamp: number) => {
    await UserActivitySyncState.updateOne(
        { walletAddress: USER_ADDRESS },
        {
            $set: {
                walletAddress: USER_ADDRESS,
                lastSyncedTimestamp: lastTrade?.timestamp || endTimestamp,
                lastSyncedActivityKey: lastTrade?.activityKey || '',
                updatedAt: Date.now(),
            },
        },
        {
            upsert: true,
        }
    );
};

const upsertTrades = async (
    fetchedTrades: UserActivityInterface[],
    storedTrades: UserActivityInterface[],
    snapshots: Map<string, TradeSnapshotFields>,
    snapshotCapturedAt: number
) => {
    const storedTradeMap = new Map(
        storedTrades
            .filter((trade): trade is UserActivityInterface => Boolean(trade.activityKey))
            .map((trade) => [trade.activityKey as string, trade])
    );
    const bulkOps = fetchedTrades.map((trade) => {
        const existingTrade = storedTradeMap.get(trade.activityKey || '');
        const snapshotData = prepareSnapshotData(trade, snapshots, snapshotCapturedAt);
        const updateSet: Record<string, unknown> = {
            ...trade,
            executionIntent: resolveExecutionIntent(trade),
        };

        if (existingTrade && shouldUpdateSnapshot(existingTrade, snapshotData)) {
            Object.assign(updateSet, snapshotData);
        }

        if (!existingTrade) {
            Object.assign(updateSet, snapshotData);
        }

        const baseDefaults =
            resolveExecutionIntent(trade) === 'EXECUTE'
                ? {
                      bot: false,
                      botExcutedTime: 0,
                      botStatus: 'PENDING',
                      botClaimedAt: 0,
                      botExecutedAt: 0,
                      botLastError: '',
                  }
                : {
                      bot: true,
                      botExcutedTime: 0,
                      botStatus: 'SKIPPED',
                      botClaimedAt: 0,
                      botExecutedAt: Date.now(),
                      botLastError: '仅用于持仓校准，不触发自动执行',
                  };

        return {
            updateOne: {
                filter: { activityKey: trade.activityKey },
                update: {
                    $set: updateSet,
                    $setOnInsert: baseDefaults,
                },
                upsert: true,
            },
        };
    });

    if (bulkOps.length > 0) {
        await UserActivity.bulkWrite(bulkOps);
    }
};

const syncStoredTrades = async (
    storedTrades: UserActivityInterface[],
    snapshots: Map<string, TradeSnapshotFields>
) => {
    const bulkOps = storedTrades
        .map((trade) => {
            const normalizedTimestamp = normalizeTimestamp(Number(trade.timestamp));
            const nextStatus = trade.botStatus || getDefaultBotStatus(trade);
            const nextActivityKey = trade.activityKey || buildActivityKey(trade);
            const snapshotData = snapshots.get(nextActivityKey);
            const updateSet: Record<string, unknown> = {};

            if (normalizedTimestamp !== null && normalizedTimestamp !== trade.timestamp) {
                updateSet.timestamp = normalizedTimestamp;
            }

            if (!trade.activityKey) {
                updateSet.activityKey = nextActivityKey;
            }

            if (!trade.botStatus) {
                updateSet.botStatus = nextStatus;
            }

            if (!trade.executionIntent) {
                updateSet.executionIntent = resolveExecutionIntent(trade);
            }

            if (!hasCompleteSnapshot(trade) && shouldUpdateSnapshot(trade, snapshotData)) {
                Object.assign(updateSet, snapshotData);
            }

            if (Object.keys(updateSet).length === 0) {
                return null;
            }

            return {
                updateOne: {
                    filter: { _id: trade._id },
                    update: { $set: updateSet },
                },
            };
        })
        .filter((operation): operation is NonNullable<typeof operation> => operation !== null);

    if (bulkOps.length > 0) {
        await UserActivity.bulkWrite(bulkOps);
    }
};

const fetchTradeData = async () => {
    try {
        const syncState = await readSyncState();
        const endTimestamp = Date.now();
        const startTimestamp = Math.max(
            0,
            (syncState?.lastSyncedTimestamp || endTimestamp - INITIAL_SYNC_LOOKBACK_MS) -
                ACTIVITY_SYNC_OVERLAP_MS
        );

        const fetchedTrades = await fetchActivityWindow(startTimestamp, endTimestamp);
        const storedTrades = (await UserActivity.find({
            timestamp: { $gte: startTimestamp },
            type: { $in: [...TRACKED_ACTIVITY_TYPES] },
        })
            .sort({ timestamp: 1 })
            .exec()) as UserActivityInterface[];
        const normalizedStoredTrades = storedTrades
            .map(normalizeTrade)
            .filter((trade): trade is UserActivityInterface => trade !== null);

        const [currentPositionsRaw, currentBalance] = await Promise.all([
            fetchData<UserPositionInterface[]>(SOURCE_POSITIONS_URL),
            getMyBalance(USER_ADDRESS),
        ]);
        const snapshotCapturedAt = Date.now();
        const snapshotSourceTrades = dedupeTradesByActivityKey([
            ...normalizedStoredTrades,
            ...fetchedTrades,
        ]);
        const snapshotMap = buildTradeSnapshots(
            snapshotSourceTrades,
            Array.isArray(currentPositionsRaw) ? currentPositionsRaw : null,
            currentBalance,
            snapshotCapturedAt
        );

        await syncStoredTrades(normalizedStoredTrades, snapshotMap);
        await upsertTrades(fetchedTrades, normalizedStoredTrades, snapshotMap, snapshotCapturedAt);
        await writeSyncState(
            fetchedTrades.length > 0 ? fetchedTrades[fetchedTrades.length - 1] : null,
            endTimestamp
        );

        const executeCount = fetchedTrades.filter(
            (trade) => resolveExecutionIntent(trade) === 'EXECUTE'
        ).length;
        const syncOnlyCount = fetchedTrades.length - executeCount;
        if (executeCount > 0 || syncOnlyCount > 0) {
            console.log(
                `同步活动 ${fetchedTrades.length} 条，其中待执行 ${executeCount} 条，仅校准 ${syncOnlyCount} 条`
            );
        }
    } catch (error) {
        console.error('抓取交易数据时发生错误:', error);
    }
};

const tradeMonitor = async () => {
    console.log('交易监控已启动，轮询间隔', FETCH_INTERVAL, '秒');

    while (true) {
        await fetchTradeData();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeMonitor;
