import { ENV } from '../config/env';
import {
    BotExecutionStatus,
    UserActivityInterface,
    UserActivitySyncStateInterface,
    UserPositionInterface,
} from '../interfaces/User';
import { getUserActivityModel, getUserActivitySyncStateModel } from '../models/userHistory';
import buildTradeSnapshots, { TradeSnapshotFields } from '../utils/buildTradeSnapshots';
import buildActivityKey from '../utils/buildActivityKey';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import createLogger from '../utils/logger';
import { resolveExecutionIntent } from '../utils/executionSemantics';
import {
    flattenSourceActivityKeys,
    flattenSourceTransactionHashes,
    getSourceActivityKeys,
    getSourceEndedAt,
    getSourceStartedAt,
    getSourceTradeCount,
    sumSourceTradeCount,
} from '../utils/sourceActivityAggregation';

const USER_ADDRESS = ENV.USER_ADDRESS;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const INITIAL_SYNC_LOOKBACK_MS = ENV.INITIAL_SYNC_LOOKBACK_MS;
const ACTIVITY_SYNC_LIMIT = ENV.ACTIVITY_SYNC_LIMIT;
const ACTIVITY_SYNC_OVERLAP_MS = ENV.ACTIVITY_SYNC_OVERLAP_MS;
const ACTIVITY_ADJACENT_MERGE_WINDOW_MS = ENV.ACTIVITY_ADJACENT_MERGE_WINDOW_MS;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;
const TRACKED_ACTIVITY_TYPES = new Set(['TRADE', 'MERGE', 'REDEEM']);
const SOURCE_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}&sizeThreshold=0`;
const logger = createLogger('monitor');
const SNAPSHOT_STATUS_PRIORITY = {
    COMPLETE: 0,
    STALE: 1,
    PARTIAL: 2,
} as const;
const SNAPSHOT_MERGE_TOLERANCE = 1e-6;
const NON_SOURCE_ACTIVITY_FIELDS = new Set([
    '_id',
    '__v',
    'bot',
    'botExcutedTime',
    'botStatus',
    'botClaimedAt',
    'botExecutedAt',
    'botLastError',
    'botOrderIds',
    'botTransactionHashes',
    'botSubmittedAt',
    'botConfirmedAt',
    'botMatchedAt',
    'botMinedAt',
    'botSubmissionStatus',
    'botBufferId',
    'botExecutionBatchId',
    'botBufferedAt',
    'botPolicyTrail',
    'createdAt',
    'updatedAt',
]);

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);
const UserActivitySyncState = getUserActivitySyncStateModel(USER_ADDRESS);

const normalizeTimestampToMilliseconds = (rawTimestamp: number): number | null => {
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
        return null;
    }

    const parsedTimestamp = Math.trunc(rawTimestamp);
    return parsedTimestamp < MILLISECOND_TIMESTAMP_THRESHOLD
        ? parsedTimestamp * 1000
        : parsedTimestamp;
};

const normalizeTimestampToSeconds = (rawTimestamp: number): number | null => {
    const normalizedTimestamp = normalizeTimestampToMilliseconds(rawTimestamp);

    if (normalizedTimestamp === null) {
        return null;
    }

    return Math.trunc(normalizedTimestamp / 1000);
};

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

const hasMergeableSnapshot = (snapshot: TradeSnapshotFields) =>
    snapshot.snapshotStatus !== 'PARTIAL' &&
    Number.isFinite(snapshot.sourcePositionSizeAfterTrade) &&
    Number.isFinite(snapshot.sourcePositionSizeBeforeTrade);

const normalizeTrade = (trade: UserActivityInterface): UserActivityInterface | null => {
    const baseTrade =
        typeof (trade as { toObject?: () => UserActivityInterface }).toObject === 'function'
            ? (trade as { toObject: () => UserActivityInterface }).toObject()
            : trade;
    const normalizedTimestamp = normalizeTimestampToMilliseconds(Number(baseTrade.timestamp));
    const transactionHash = String(baseTrade.transactionHash || '').trim();
    const type = String(baseTrade.type || '')
        .trim()
        .toUpperCase();

    if (normalizedTimestamp === null) {
        logger.warn(`跳过时间戳无效的活动 tx=${transactionHash || 'unknown-hash'}`);
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
        activityKey:
            String(baseTrade.activityKey || '').trim() || buildActivityKey(normalizedTrade),
    };
};

const sanitizeSourceActivityUpdateSet = (trade: Record<string, unknown>) =>
    Object.fromEntries(
        Object.entries(trade).filter(([key]) => !NON_SOURCE_ACTIVITY_FIELDS.has(key))
    );

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

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSnapshotStatus = (value: string | undefined) =>
    value === 'PARTIAL' || value === 'STALE' || value === 'COMPLETE' ? value : 'PARTIAL';

const pickMergedSnapshotStatus = (
    left: string | undefined,
    right: string | undefined
): 'COMPLETE' | 'PARTIAL' | 'STALE' => {
    const normalizedLeft = normalizeSnapshotStatus(left);
    const normalizedRight = normalizeSnapshotStatus(right);

    return SNAPSHOT_STATUS_PRIORITY[normalizedLeft] >= SNAPSHOT_STATUS_PRIORITY[normalizedRight]
        ? normalizedLeft
        : normalizedRight;
};

const mergeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()).filter(Boolean))].join('；');

const approxEqual = (left: unknown, right: unknown, tolerance = SNAPSHOT_MERGE_TOLERANCE) =>
    Math.abs(toSafeNumber(left) - toSafeNumber(right)) <= tolerance;

const buildSnapshotFromTrade = (
    trade: Partial<UserActivityInterface>,
    fallbackCapturedAt: number
): TradeSnapshotFields => ({
    sourceBalanceAfterTrade: Number.isFinite(trade.sourceBalanceAfterTrade)
        ? trade.sourceBalanceAfterTrade
        : undefined,
    sourceBalanceBeforeTrade: Number.isFinite(trade.sourceBalanceBeforeTrade)
        ? trade.sourceBalanceBeforeTrade
        : undefined,
    sourcePositionSizeAfterTrade: Number.isFinite(trade.sourcePositionSizeAfterTrade)
        ? trade.sourcePositionSizeAfterTrade
        : undefined,
    sourcePositionSizeBeforeTrade: Number.isFinite(trade.sourcePositionSizeBeforeTrade)
        ? trade.sourcePositionSizeBeforeTrade
        : undefined,
    sourcePositionPriceAfterTrade: Number.isFinite(trade.sourcePositionPriceAfterTrade)
        ? trade.sourcePositionPriceAfterTrade
        : undefined,
    sourceConditionMergeableSizeAfterTrade: Number.isFinite(
        trade.sourceConditionMergeableSizeAfterTrade
    )
        ? trade.sourceConditionMergeableSizeAfterTrade
        : undefined,
    sourceConditionMergeableSizeBeforeTrade: Number.isFinite(
        trade.sourceConditionMergeableSizeBeforeTrade
    )
        ? trade.sourceConditionMergeableSizeBeforeTrade
        : undefined,
    sourceSnapshotCapturedAt: toSafeNumber(trade.sourceSnapshotCapturedAt, fallbackCapturedAt),
    snapshotStatus: normalizeSnapshotStatus(trade.snapshotStatus),
    sourceSnapshotReason: String(trade.sourceSnapshotReason || '').trim(),
});

const buildActivityMergeKey = (trade: Partial<UserActivityInterface>) =>
    [
        String(trade.type || '')
            .trim()
            .toUpperCase(),
        String(trade.conditionId || '').trim(),
        String(trade.asset || '').trim(),
        String(
            Number.isFinite(trade.outcomeIndex) ? trade.outcomeIndex : String(trade.outcome || '')
        ).trim(),
        String(trade.side || '')
            .trim()
            .toUpperCase(),
    ].join('|');

const isExpandableStoredTrade = (trade: UserActivityInterface) =>
    trade.type === 'TRADE' &&
    resolveExecutionIntent(trade) === 'EXECUTE' &&
    (!trade.botStatus || trade.botStatus === 'PENDING') &&
    !trade.botBufferId &&
    !trade.botExecutionBatchId;

const canMergeAdjacentActivities = (
    previousTrade: UserActivityInterface,
    previousSnapshot: TradeSnapshotFields,
    nextTrade: UserActivityInterface,
    nextSnapshot: TradeSnapshotFields
) => {
    if (previousTrade.type !== 'TRADE' || nextTrade.type !== 'TRADE') {
        return false;
    }

    if (buildActivityMergeKey(previousTrade) !== buildActivityMergeKey(nextTrade)) {
        return false;
    }

    if (!hasMergeableSnapshot(previousSnapshot) || !hasMergeableSnapshot(nextSnapshot)) {
        return false;
    }

    if (
        getSourceEndedAt(nextTrade) - getSourceStartedAt(previousTrade) <
        getSourceEndedAt(previousTrade) - getSourceStartedAt(previousTrade)
    ) {
        return false;
    }

    if (
        getSourceStartedAt(nextTrade) - getSourceEndedAt(previousTrade) >
        ACTIVITY_ADJACENT_MERGE_WINDOW_MS
    ) {
        return false;
    }

    if (
        !approxEqual(
            previousSnapshot.sourcePositionSizeAfterTrade,
            nextSnapshot.sourcePositionSizeBeforeTrade
        )
    ) {
        return false;
    }

    if (
        String(previousTrade.side || '')
            .trim()
            .toUpperCase() === 'BUY' &&
        Number.isFinite(previousSnapshot.sourceBalanceAfterTrade) &&
        Number.isFinite(nextSnapshot.sourceBalanceBeforeTrade) &&
        !approxEqual(
            previousSnapshot.sourceBalanceAfterTrade,
            nextSnapshot.sourceBalanceBeforeTrade
        )
    ) {
        return false;
    }

    return true;
};

const createMergedTradeCandidate = (
    trade: UserActivityInterface,
    snapshot: TradeSnapshotFields
): {
    trade: UserActivityInterface;
    snapshot: TradeSnapshotFields;
} => ({
    trade: {
        ...trade,
        sourceActivityKeys: getSourceActivityKeys(trade),
        sourceTransactionHashes: flattenSourceTransactionHashes([trade]),
        sourceTradeCount: getSourceTradeCount(trade),
        sourceStartedAt: getSourceStartedAt(trade),
        sourceEndedAt: getSourceEndedAt(trade),
        sourceBalanceAfterTrade: snapshot.sourceBalanceAfterTrade,
        sourceBalanceBeforeTrade: snapshot.sourceBalanceBeforeTrade,
        sourcePositionSizeAfterTrade: snapshot.sourcePositionSizeAfterTrade,
        sourcePositionSizeBeforeTrade: snapshot.sourcePositionSizeBeforeTrade,
        sourcePositionPriceAfterTrade: snapshot.sourcePositionPriceAfterTrade,
        sourceConditionMergeableSizeAfterTrade: snapshot.sourceConditionMergeableSizeAfterTrade,
        sourceConditionMergeableSizeBeforeTrade: snapshot.sourceConditionMergeableSizeBeforeTrade,
        sourceSnapshotCapturedAt: snapshot.sourceSnapshotCapturedAt,
        snapshotStatus: snapshot.snapshotStatus,
        sourceSnapshotReason: snapshot.sourceSnapshotReason,
    },
    snapshot,
});

const mergeTradeCandidates = (
    previousCandidate: {
        trade: UserActivityInterface;
        snapshot: TradeSnapshotFields;
    },
    nextTrade: UserActivityInterface,
    nextSnapshot: TradeSnapshotFields
) => {
    const mergedSize = toSafeNumber(previousCandidate.trade.size) + toSafeNumber(nextTrade.size);
    const mergedUsdc =
        toSafeNumber(previousCandidate.trade.usdcSize) + toSafeNumber(nextTrade.usdcSize);
    const mergedSnapshot: TradeSnapshotFields = {
        sourceBalanceAfterTrade: nextSnapshot.sourceBalanceAfterTrade,
        sourceBalanceBeforeTrade: previousCandidate.snapshot.sourceBalanceBeforeTrade,
        sourcePositionSizeAfterTrade: nextSnapshot.sourcePositionSizeAfterTrade,
        sourcePositionSizeBeforeTrade: previousCandidate.snapshot.sourcePositionSizeBeforeTrade,
        sourcePositionPriceAfterTrade: nextSnapshot.sourcePositionPriceAfterTrade,
        sourceConditionMergeableSizeAfterTrade: nextSnapshot.sourceConditionMergeableSizeAfterTrade,
        sourceConditionMergeableSizeBeforeTrade:
            previousCandidate.snapshot.sourceConditionMergeableSizeBeforeTrade,
        sourceSnapshotCapturedAt: Math.max(
            toSafeNumber(previousCandidate.snapshot.sourceSnapshotCapturedAt),
            toSafeNumber(nextSnapshot.sourceSnapshotCapturedAt)
        ),
        snapshotStatus: pickMergedSnapshotStatus(
            previousCandidate.snapshot.snapshotStatus,
            nextSnapshot.snapshotStatus
        ),
        sourceSnapshotReason: mergeReasons(
            previousCandidate.snapshot.sourceSnapshotReason,
            nextSnapshot.sourceSnapshotReason
        ),
    };

    return {
        trade: {
            ...previousCandidate.trade,
            proxyWallet: nextTrade.proxyWallet,
            timestamp: nextTrade.timestamp,
            transactionHash: nextTrade.transactionHash,
            price:
                mergedSize > 0
                    ? mergedUsdc / mergedSize
                    : Math.max(toSafeNumber(nextTrade.price), 0),
            size: mergedSize,
            usdcSize: mergedUsdc,
            title: nextTrade.title || previousCandidate.trade.title,
            slug: nextTrade.slug || previousCandidate.trade.slug,
            eventSlug: nextTrade.eventSlug || previousCandidate.trade.eventSlug,
            outcome: nextTrade.outcome || previousCandidate.trade.outcome,
            outcomeIndex: Number.isFinite(nextTrade.outcomeIndex)
                ? nextTrade.outcomeIndex
                : previousCandidate.trade.outcomeIndex,
            sourceActivityKeys: flattenSourceActivityKeys([previousCandidate.trade, nextTrade]),
            sourceTransactionHashes: flattenSourceTransactionHashes([
                previousCandidate.trade,
                nextTrade,
            ]),
            sourceTradeCount: sumSourceTradeCount([previousCandidate.trade, nextTrade]),
            sourceStartedAt: Math.min(
                getSourceStartedAt(previousCandidate.trade),
                getSourceStartedAt(nextTrade)
            ),
            sourceEndedAt: Math.max(
                getSourceEndedAt(previousCandidate.trade),
                getSourceEndedAt(nextTrade)
            ),
            sourceBalanceAfterTrade: mergedSnapshot.sourceBalanceAfterTrade,
            sourceBalanceBeforeTrade: mergedSnapshot.sourceBalanceBeforeTrade,
            sourcePositionSizeAfterTrade: mergedSnapshot.sourcePositionSizeAfterTrade,
            sourcePositionSizeBeforeTrade: mergedSnapshot.sourcePositionSizeBeforeTrade,
            sourcePositionPriceAfterTrade: mergedSnapshot.sourcePositionPriceAfterTrade,
            sourceConditionMergeableSizeAfterTrade:
                mergedSnapshot.sourceConditionMergeableSizeAfterTrade,
            sourceConditionMergeableSizeBeforeTrade:
                mergedSnapshot.sourceConditionMergeableSizeBeforeTrade,
            sourceSnapshotCapturedAt: mergedSnapshot.sourceSnapshotCapturedAt,
            snapshotStatus: mergedSnapshot.snapshotStatus,
            sourceSnapshotReason: mergedSnapshot.sourceSnapshotReason,
        },
        snapshot: mergedSnapshot,
    };
};

const mergeFetchedTrades = (
    fetchedTrades: UserActivityInterface[],
    storedTrades: UserActivityInterface[],
    snapshots: Map<string, TradeSnapshotFields>,
    snapshotCapturedAt: number
) => {
    const mergedByActivityKey = new Map<
        string,
        {
            trade: UserActivityInterface;
            snapshot: TradeSnapshotFields;
        }
    >();
    const mergeTargetByIdentity = new Map<
        string,
        {
            trade: UserActivityInterface;
            snapshot: TradeSnapshotFields;
        }
    >();

    for (const storedTrade of storedTrades
        .filter(isExpandableStoredTrade)
        .sort((left, right) => left.timestamp - right.timestamp)) {
        const activityKey = String(storedTrade.activityKey || '').trim();
        if (!activityKey) {
            continue;
        }

        mergeTargetByIdentity.set(buildActivityMergeKey(storedTrade), {
            trade: storedTrade,
            snapshot:
                snapshots.get(activityKey) ||
                buildSnapshotFromTrade(storedTrade, snapshotCapturedAt),
        });
    }

    for (const trade of fetchedTrades) {
        const activityKey = String(trade.activityKey || '').trim();
        if (!activityKey) {
            continue;
        }

        const nextSnapshot =
            snapshots.get(activityKey) || buildSnapshotFromTrade(trade, snapshotCapturedAt);
        const identity = buildActivityMergeKey(trade);
        const currentCandidate = mergeTargetByIdentity.get(identity);

        if (
            currentCandidate &&
            (String(currentCandidate.trade.activityKey || '').trim() === activityKey ||
                getSourceActivityKeys(currentCandidate.trade).includes(activityKey))
        ) {
            continue;
        }

        if (
            currentCandidate &&
            canMergeAdjacentActivities(
                currentCandidate.trade,
                currentCandidate.snapshot,
                trade,
                nextSnapshot
            )
        ) {
            const mergedCandidate = mergeTradeCandidates(currentCandidate, trade, nextSnapshot);
            mergeTargetByIdentity.set(identity, mergedCandidate);
            mergedByActivityKey.set(
                String(mergedCandidate.trade.activityKey || ''),
                mergedCandidate
            );
            continue;
        }

        const freshCandidate = createMergedTradeCandidate(trade, nextSnapshot);
        mergeTargetByIdentity.set(identity, freshCandidate);
        mergedByActivityKey.set(String(freshCandidate.trade.activityKey || ''), freshCandidate);
    }

    return {
        trades: [...mergedByActivityKey.values()].map((candidate) => candidate.trade),
        snapshots: new Map(
            [...mergedByActivityKey.values()].map((candidate) => [
                String(candidate.trade.activityKey || ''),
                candidate.snapshot,
            ])
        ),
    };
};

const fetchActivityWindow = async (startTimestamp: number, endTimestamp: number) => {
    const tradeMap = new Map<string, UserActivityInterface>();
    const normalizedStartTimestamp = normalizeTimestampToSeconds(startTimestamp);
    const normalizedEndTimestamp = normalizeTimestampToSeconds(endTimestamp);

    if (
        normalizedStartTimestamp === null ||
        normalizedEndTimestamp === null ||
        normalizedStartTimestamp > normalizedEndTimestamp
    ) {
        logger.warn('活动抓取窗口无效，已跳过本轮同步');
        return [];
    }

    let cursor = normalizedStartTimestamp;

    while (cursor <= normalizedEndTimestamp) {
        const params = new URLSearchParams({
            user: USER_ADDRESS,
            start: String(cursor),
            end: String(normalizedEndTimestamp),
            limit: String(ACTIVITY_SYNC_LIMIT),
            sortDirection: 'ASC',
        });
        const activitiesRaw = await fetchData<UserActivityInterface[]>(
            `https://data-api.polymarket.com/activity?${params.toString()}`
        );

        if (!Array.isArray(activitiesRaw)) {
            logger.warn('活动接口暂不可用，已跳过本轮同步');
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
            .map((activity) => normalizeTimestampToSeconds(Number(activity.timestamp)))
            .find((timestamp): timestamp is number => timestamp !== null);
        if (!lastRawTimestamp) {
            break;
        }

        const nextCursor = lastRawTimestamp + 1;
        if (nextCursor <= cursor) {
            logger.warn('活动分页游标未推进，已提前结束本轮同步');
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
        const updateSet: Record<string, unknown> = sanitizeSourceActivityUpdateSet({
            ...trade,
            executionIntent: resolveExecutionIntent(trade),
        });

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

const loadSyncedTradesForCallback = async (trades: UserActivityInterface[]) => {
    const activityKeys = [...new Set(trades.map((trade) => String(trade.activityKey || '').trim()))]
        .filter(Boolean);
    if (activityKeys.length === 0) {
        return [] as UserActivityInterface[];
    }

    const persistedTrades = (await UserActivity.find({
        activityKey: { $in: activityKeys },
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];
    const normalizedPersistedTrades = persistedTrades
        .map(normalizeTrade)
        .filter((trade): trade is UserActivityInterface => trade !== null);
    const tradeByActivityKey = new Map(
        normalizedPersistedTrades.map((trade) => [String(trade.activityKey || ''), trade])
    );

    return activityKeys
        .map((activityKey) => tradeByActivityKey.get(activityKey))
        .filter((trade): trade is UserActivityInterface => Boolean(trade));
};

const syncStoredTrades = async (
    storedTrades: UserActivityInterface[],
    snapshots: Map<string, TradeSnapshotFields>
) => {
    const bulkOps = storedTrades
        .map((trade) => {
            const normalizedTimestamp = normalizeTimestampToMilliseconds(Number(trade.timestamp));
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

interface TradeMonitorOptions {
    onSourceTradesSynced?: (trades: UserActivityInterface[]) => void;
}

const fetchTradeData = async (options: TradeMonitorOptions = {}) => {
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
        const mergedFetchedTrades = mergeFetchedTrades(
            fetchedTrades,
            normalizedStoredTrades,
            snapshotMap,
            snapshotCapturedAt
        );

        await syncStoredTrades(normalizedStoredTrades, snapshotMap);
        await upsertTrades(
            mergedFetchedTrades.trades,
            normalizedStoredTrades,
            mergedFetchedTrades.snapshots,
            snapshotCapturedAt
        );
        const callbackTrades = await loadSyncedTradesForCallback(mergedFetchedTrades.trades);
        options.onSourceTradesSynced?.(callbackTrades);
        await writeSyncState(
            fetchedTrades.length > 0 ? fetchedTrades[fetchedTrades.length - 1] : null,
            endTimestamp
        );

        const executeCount = mergedFetchedTrades.trades.filter(
            (trade) => resolveExecutionIntent(trade) === 'EXECUTE'
        ).length;
        const syncOnlyCount = mergedFetchedTrades.trades.length - executeCount;
        if (executeCount > 0 || syncOnlyCount > 0) {
            logger.debug(
                `活动同步 fetched=${fetchedTrades.length} merged=${mergedFetchedTrades.trades.length} ` +
                    `execute=${executeCount} syncOnly=${syncOnlyCount}`
            );
        }
    } catch (error) {
        logger.error('同步活动失败', error);
    }
};

const tradeMonitor = async (options: TradeMonitorOptions = {}) => {
    logger.info(`启动，轮询间隔=${FETCH_INTERVAL}s`);

    while (true) {
        await fetchTradeData(options);
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeMonitor;
