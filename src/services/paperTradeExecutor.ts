import { Side } from '@polymarket/clob-client';
import { HydratedDocument } from 'mongoose';
import {
    CopyExecutionBatchInterface,
    CopyIntentBufferInterface,
    ExecutionPolicyTrailEntry,
} from '../interfaces/Execution';
import {
    TracePortfolioInterface,
    TracePositionInterface,
    TraceSettlementTaskInterface,
} from '../interfaces/Trace';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getCopyExecutionBatchModel, getCopyIntentBufferModel } from '../models/copyExecution';
import {
    getTraceExecutionModel,
    getTracePortfolioModel,
    getTracePositionModel,
    getTraceSettlementTaskModel,
} from '../models/traceHistory';
import { getUserActivityModel } from '../models/userHistory';
import ClobMarketStream from './clobMarketStream';
import {
    buildBuyBufferExpireAt,
    buildBuyBufferFlushAfter,
    buildBuyBufferKey,
    evaluateBuyBuffer,
    sortTradesAsc,
} from '../utils/copyIntentPlanning';
import {
    buildChunkExecutionPlan,
    cloneMarketSnapshot,
    consumeMarketLiquidity,
} from '../utils/executionPlanning';
import {
    buildConditionOutcomeKey,
    computeConditionMergeableSize,
} from '../utils/conditionPositionMath';
import fetchData from '../utils/fetchData';
import createLogger from '../utils/logger';
import {
    buildPolymarketMarketSlugFromTitle,
    fetchPolymarketMarketResolution,
    isResolvedPolymarketMarket,
    normalizeOutcomeLabel,
    PolymarketMarketResolution,
} from '../utils/polymarketMarketResolution';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import spinner from '../utils/spinner';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TRACE_ID = ENV.TRACE_ID;
const TRACE_LABEL = ENV.TRACE_LABEL;
const TRACE_INITIAL_BALANCE = ENV.TRACE_INITIAL_BALANCE;
const TRACE_RUNTIME_NAMESPACE = `trace_${TRACE_ID}`;
const logger = createLogger(TRACE_LABEL);

const SourceActivity = getUserActivityModel(USER_ADDRESS);
const TraceIntentBuffer = getCopyIntentBufferModel(USER_ADDRESS, TRACE_RUNTIME_NAMESPACE);
const TraceExecutionBatch = getCopyExecutionBatchModel(USER_ADDRESS, TRACE_RUNTIME_NAMESPACE);
const TraceExecution = getTraceExecutionModel(USER_ADDRESS, TRACE_ID);
const TracePortfolio = getTracePortfolioModel(USER_ADDRESS, TRACE_ID);
const TracePosition = getTracePositionModel(USER_ADDRESS, TRACE_ID);
const TraceSettlementTask = getTraceSettlementTaskModel(USER_ADDRESS, TRACE_ID);

const EPSILON = 1e-8;
const SETTLEMENT_PRICE = 1;
const PROCESSING_LEASE_MS = ENV.PROCESSING_LEASE_MS;
const SOURCE_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}&sizeThreshold=0`;
const TRACE_PORTFOLIO_SYNC_INTERVAL_MS = 15_000;
const TRACE_SETTLEMENT_TASK_SYNC_INTERVAL_MS = 15_000;
const TRACE_SETTLEMENT_RETRY_BASE_MS = 5_000;
const TRACE_SETTLEMENT_RETRY_MAX_MS = 60_000;
const RESOLUTION_CACHE_RESOLVED_TTL_MS = 10 * 60_000;
const RESOLUTION_CACHE_UNRESOLVED_TTL_MS = 30_000;
const resolutionCache = new Map<
    string,
    {
        checkedAt: number;
        resolution: PolymarketMarketResolution | null;
    }
>();

type ExecutionStatus = 'FILLED' | 'SKIPPED';
type TracePortfolioDocument = HydratedDocument<TracePortfolioInterface>;
type TracePositionDocument = HydratedDocument<TracePositionInterface>;
type TraceSettlementTaskDocument = HydratedDocument<TraceSettlementTaskInterface>;

interface ConditionMetadata {
    conditionId: string;
    marketSlug: string;
    title: string;
}

interface ConditionSettlementOutcome {
    status: 'FILLED' | 'SKIPPED';
    reason: string;
    resolution: PolymarketMarketResolution | null;
    positionSizeBefore?: number;
}

type SettlementTaskStatus = TraceSettlementTaskInterface['status'];

interface ExecutionResult {
    status: ExecutionStatus;
    reason: string;
    requestedSize: number;
    executedSize: number;
    requestedUsdc: number;
    executedUsdc: number;
    executionPrice: number;
    cashBefore: number;
    cashAfter: number;
    positionSizeBefore: number;
    positionSizeAfter: number;
    realizedPnlDelta: number;
    unrealizedPnlAfter: number;
}

interface ExecutionTargetOverrides {
    requestedUsdc?: number;
    requestedSize?: number;
    sourcePrice?: number;
    note?: string;
}

class RetryableTraceError extends Error {}

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSize = (value: number) => (Math.abs(value) < EPSILON ? 0 : value);
const formatAmount = (value: unknown) => toSafeNumber(value).toFixed(4);
const formatTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset' | 'side'>) =>
    `tx=${trade.transactionHash} side=${String(trade.side || '').toUpperCase()} asset=${trade.asset}`;
const formatBatchRef = (
    batch: Pick<CopyExecutionBatchInterface, 'asset' | 'condition' | 'sourceTradeCount'>
) => `condition=${batch.condition} asset=${batch.asset} trades=${batch.sourceTradeCount}`;
const mergeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()))].filter(Boolean).join('；');
const mergePolicyTrail = (
    ...groups: Array<ExecutionPolicyTrailEntry[] | undefined>
): ExecutionPolicyTrailEntry[] => {
    const merged = groups.flatMap((group) => group || []);
    const seen = new Set<string>();
    return merged.filter((entry) => {
        const key = `${entry.policyId}:${entry.action}:${entry.reason}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};
const buildPolicyTrailEntry = (
    policyId: string,
    action: ExecutionPolicyTrailEntry['action'],
    reason: string
): ExecutionPolicyTrailEntry => ({
    policyId,
    action,
    reason,
    timestamp: Date.now(),
});
const buildLeaseCutoff = () => Date.now() - PROCESSING_LEASE_MS;
const buildConditionSettlementRetryDelayMs = (retryCount: number) =>
    Math.min(
        TRACE_SETTLEMENT_RETRY_BASE_MS * 2 ** Math.max(Math.min(retryCount, 4), 0),
        TRACE_SETTLEMENT_RETRY_MAX_MS
    );
const buildClaimableFilter = (fieldName: string, leaseCutoff: number) => ({
    $or: [
        { [fieldName]: { $exists: false } },
        { [fieldName]: 0 },
        { [fieldName]: { $lt: leaseCutoff } },
    ],
});
const getBatchExecutionKey = (batchId: CopyExecutionBatchInterface['_id']) =>
    `batch:${String(batchId)}`;
const getConditionSettlementTaskReason = (reason: string) =>
    String(reason || '').trim() || '等待 condition 级自动结算';

const updatePositionMark = (position: TracePositionDocument, marketPrice: number) => {
    if (!position || marketPrice <= 0) {
        return;
    }

    position.marketPrice = marketPrice;
    position.marketValue = position.size * marketPrice;
    position.unrealizedPnl = position.marketValue - position.costBasis;
    position.avgPrice = position.size > 0 ? position.costBasis / position.size : 0;
};

const ensurePortfolio = async (): Promise<TracePortfolioDocument> => {
    let portfolio = (await TracePortfolio.findOne({}).exec()) as TracePortfolioDocument | null;

    if (!portfolio) {
        portfolio = await TracePortfolio.create({
            traceId: TRACE_ID,
            traceLabel: TRACE_LABEL,
            sourceWallet: USER_ADDRESS,
            initialBalance: TRACE_INITIAL_BALANCE,
            cashBalance: TRACE_INITIAL_BALANCE,
            realizedPnl: 0,
            unrealizedPnl: 0,
            positionsMarketValue: 0,
            totalEquity: TRACE_INITIAL_BALANCE,
            netPnl: 0,
            returnPct: 0,
            totalExecutions: 0,
            filledExecutions: 0,
            skippedExecutions: 0,
            lastSourceTransactionHash: '',
            lastUpdatedAt: 0,
        });
    }

    return portfolio;
};

const collectPortfolioMetrics = async (portfolio: TracePortfolioDocument) => {
    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    const positionsMarketValue = activePositions.reduce(
        (sum, position) => sum + toSafeNumber(position.marketValue),
        0
    );
    const unrealizedPnl = activePositions.reduce(
        (sum, position) => sum + toSafeNumber(position.unrealizedPnl),
        0
    );
    const totalEquity = toSafeNumber(portfolio.cashBalance) + positionsMarketValue;
    const netPnl = toSafeNumber(portfolio.realizedPnl) + unrealizedPnl;
    const returnPct =
        toSafeNumber(portfolio.initialBalance) > 0
            ? (netPnl / toSafeNumber(portfolio.initialBalance)) * 100
            : 0;

    return {
        positionsMarketValue,
        unrealizedPnl,
        totalEquity,
        netPnl,
        returnPct,
    };
};

const applyPortfolioMetrics = (
    portfolio: TracePortfolioDocument,
    metrics: Awaited<ReturnType<typeof collectPortfolioMetrics>>
) => {
    portfolio.positionsMarketValue = metrics.positionsMarketValue;
    portfolio.unrealizedPnl = metrics.unrealizedPnl;
    portfolio.totalEquity = metrics.totalEquity;
    portfolio.netPnl = metrics.netPnl;
    portfolio.returnPct = metrics.returnPct;
};

const refreshPortfolioState = async (portfolio: TracePortfolioDocument) => {
    const metrics = await collectPortfolioMetrics(portfolio);
    applyPortfolioMetrics(portfolio, metrics);
    await portfolio.save();
    return metrics;
};

const createEmptyPosition = (trade: UserActivityInterface): TracePositionDocument =>
    new TracePosition({
        traceId: TRACE_ID,
        traceLabel: TRACE_LABEL,
        sourceWallet: USER_ADDRESS,
        asset: trade.asset,
        conditionId: trade.conditionId,
        marketSlug: String(trade.eventSlug || trade.slug || '').trim(),
        title: trade.title,
        outcome: trade.outcome,
        outcomeIndex: Number.isFinite(trade.outcomeIndex) ? trade.outcomeIndex : -1,
        side: trade.side,
        size: 0,
        avgPrice: 0,
        costBasis: 0,
        marketPrice: 0,
        marketValue: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalBoughtSize: 0,
        totalSoldSize: 0,
        totalBoughtUsdc: 0,
        totalSoldUsdc: 0,
        lastSourceTransactionHash: '',
        lastTradedAt: trade.timestamp,
    });

const matchUserPosition = (
    userPositions: UserPositionInterface[],
    tracePosition: Pick<
        TracePositionInterface,
        'asset' | 'conditionId' | 'outcome' | 'outcomeIndex'
    >
) =>
    userPositions.find((userPosition) => userPosition.asset === tracePosition.asset) ||
    userPositions.find(
        (userPosition) =>
            userPosition.conditionId === tracePosition.conditionId &&
            userPosition.outcomeIndex === tracePosition.outcomeIndex
    ) ||
    userPositions.find(
        (userPosition) =>
            userPosition.conditionId === tracePosition.conditionId &&
            normalizeOutcomeLabel(userPosition.outcome) ===
                normalizeOutcomeLabel(tracePosition.outcome)
    );

const fetchSourcePositions = async () => {
    const userPositionsRaw = await fetchData<UserPositionInterface[]>(SOURCE_POSITIONS_URL);
    if (!Array.isArray(userPositionsRaw)) {
        logger.warn('源账户持仓接口不可用，已跳过本轮市值刷新');
        return null;
    }

    return userPositionsRaw;
};

const refreshOpenPositionMarks = async (userPositions: UserPositionInterface[]) => {
    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];

    for (const tracePosition of activePositions) {
        const matchedUserPosition = matchUserPosition(userPositions, tracePosition);
        const nextMarketPrice = toSafeNumber(
            matchedUserPosition?.curPrice,
            toSafeNumber(tracePosition.marketPrice)
        );

        if (nextMarketPrice <= 0 || nextMarketPrice === toSafeNumber(tracePosition.marketPrice)) {
            continue;
        }

        updatePositionMark(tracePosition, nextMarketPrice);
        await tracePosition.save();
    }
};

const getConditionSettlementExecutionKey = (conditionId: string) =>
    `condition-settlement:${conditionId}`;
const getConditionTriggerExecutionKey = (trade: UserActivityInterface) =>
    `condition-trigger:${trade.activityKey || trade.transactionHash || String(trade._id)}`;

const loadConditionMetadataFromSource = async (conditionId: string): Promise<ConditionMetadata> => {
    const sourceActivity = (await SourceActivity.findOne(
        { conditionId },
        {
            conditionId: 1,
            title: 1,
            slug: 1,
            eventSlug: 1,
            timestamp: 1,
        }
    )
        .sort({ timestamp: -1 })
        .exec()) as Pick<
        UserActivityInterface,
        'conditionId' | 'title' | 'slug' | 'eventSlug'
    > | null;

    const title = String(sourceActivity?.title || '').trim();
    const marketSlug = String(sourceActivity?.eventSlug || sourceActivity?.slug || '').trim();

    return {
        conditionId,
        marketSlug: marketSlug || buildPolymarketMarketSlugFromTitle(title),
        title,
    };
};

const resolveConditionMetadata = async (
    conditionId: string,
    positions: Array<Pick<TracePositionInterface, 'conditionId' | 'marketSlug' | 'title'>>,
    triggerTrades: Array<
        Pick<UserActivityInterface, 'conditionId' | 'title' | 'slug' | 'eventSlug'>
    > = []
): Promise<ConditionMetadata> => {
    const triggerWithSlug = triggerTrades.find(
        (trade) => String(trade.eventSlug || trade.slug || '').trim() !== ''
    );
    const positionWithSlug = positions.find(
        (position) => String(position.marketSlug || '').trim() !== ''
    );
    const title = String(
        triggerWithSlug?.title || positionWithSlug?.title || positions[0]?.title || ''
    ).trim();
    const marketSlug = String(
        triggerWithSlug?.eventSlug || triggerWithSlug?.slug || positionWithSlug?.marketSlug || ''
    ).trim();

    if (marketSlug || title) {
        return {
            conditionId,
            marketSlug: marketSlug || buildPolymarketMarketSlugFromTitle(title),
            title,
        };
    }

    return loadConditionMetadataFromSource(conditionId);
};

const loadConditionResolution = async (
    metadata: ConditionMetadata,
    options: {
        forceRefresh?: boolean;
    } = {}
) => {
    if (!metadata.marketSlug) {
        return null;
    }

    const cached = resolutionCache.get(metadata.conditionId);
    if (!options.forceRefresh && cached?.resolution?.marketSlug === metadata.marketSlug) {
        const ttl = isResolvedPolymarketMarket(cached.resolution)
            ? RESOLUTION_CACHE_RESOLVED_TTL_MS
            : RESOLUTION_CACHE_UNRESOLVED_TTL_MS;
        if (Date.now() - cached.checkedAt < ttl) {
            return cached.resolution;
        }
    }

    const resolution = await fetchPolymarketMarketResolution(metadata.marketSlug);
    if (resolution) {
        resolutionCache.set(metadata.conditionId, {
            checkedAt: Date.now(),
            resolution,
        });
        return resolution;
    }

    if (cached?.resolution?.marketSlug === metadata.marketSlug) {
        return cached.resolution;
    }

    resolutionCache.set(metadata.conditionId, {
        checkedAt: Date.now(),
        resolution: null,
    });
    return null;
};

const mergeStringArrays = (...values: string[][]) => [
    ...new Set(
        values
            .flatMap((items) => items)
            .map((item) => String(item || '').trim())
            .filter(Boolean)
    ),
];

const mergeActivityIds = (...values: Array<Array<unknown>>) => {
    const merged = new Map<string, unknown>();
    for (const items of values) {
        for (const item of items) {
            const key = String(item || '').trim();
            if (!key || merged.has(key)) {
                continue;
            }

            merged.set(key, item);
        }
    }

    return [...merged.values()] as UserActivityInterface['_id'][];
};

const loadConditionSettlementTriggerTrades = async (conditionId: string) => {
    const task = (await TraceSettlementTask.findOne(
        {
            conditionId,
        },
        {
            sourceActivityIds: 1,
        }
    ).exec()) as Pick<TraceSettlementTaskInterface, 'sourceActivityIds'> | null;

    if (!task?.sourceActivityIds?.length) {
        return [];
    }

    return (await SourceActivity.find(
        {
            _id: {
                $in: task.sourceActivityIds,
            },
        },
        {
            _id: 1,
            activityKey: 1,
            conditionId: 1,
            eventSlug: 1,
            slug: 1,
            timestamp: 1,
            title: 1,
            transactionHash: 1,
            type: 1,
        }
    )
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];
};

const upsertConditionSettlementTask = async (params: {
    conditionId: string;
    metadata: ConditionMetadata;
    reason: string;
    resolution?: PolymarketMarketResolution | null;
    triggerTrades?: UserActivityInterface[];
    nextRetryAt?: number;
}) => {
    const {
        conditionId,
        metadata,
        reason,
        resolution,
        triggerTrades = [],
        nextRetryAt = 0,
    } = params;
    const existingTask = (await TraceSettlementTask.findOne(
        {
            conditionId,
        },
        {
            sourceActivityId: 1,
            sourceActivityIds: 1,
            sourceActivityKeys: 1,
            sourceTransactionHash: 1,
            sourceTransactionHashes: 1,
            sourceStartedAt: 1,
            sourceEndedAt: 1,
            sourceTimestamp: 1,
        }
    ).exec()) as
        | (Pick<
              TraceSettlementTaskInterface,
              | 'sourceActivityId'
              | 'sourceActivityIds'
              | 'sourceActivityKeys'
              | 'sourceTransactionHash'
              | 'sourceTransactionHashes'
              | 'sourceStartedAt'
              | 'sourceEndedAt'
              | 'sourceTimestamp'
          > & {
              _id?: TraceSettlementTaskInterface['_id'];
          })
        | null;
    const orderedTrades = sortTradesAsc(triggerTrades);
    const latestTrade = orderedTrades[orderedTrades.length - 1];
    const firstTrade = orderedTrades[0];
    const mergedActivityIds = mergeActivityIds(
        existingTask?.sourceActivityId ? [existingTask.sourceActivityId] : [],
        existingTask?.sourceActivityIds || [],
        orderedTrades.map((trade) => trade._id)
    );
    const now = Date.now();
    const referenceTimestamp =
        latestTrade?.timestamp || toSafeNumber(existingTask?.sourceTimestamp) || now;
    const sourceStartedAtCandidates = [
        firstTrade?.timestamp,
        toSafeNumber(existingTask?.sourceStartedAt),
        referenceTimestamp,
    ].filter((value) => toSafeNumber(value) > 0);
    const sourceEndedAtCandidates = [
        latestTrade?.timestamp,
        toSafeNumber(existingTask?.sourceEndedAt),
        referenceTimestamp,
    ].filter((value) => toSafeNumber(value) > 0);
    const sourceStartedAt =
        sourceStartedAtCandidates.length > 0
            ? Math.min(...sourceStartedAtCandidates.map((value) => toSafeNumber(value)))
            : referenceTimestamp;
    const sourceEndedAt =
        sourceEndedAtCandidates.length > 0
            ? Math.max(...sourceEndedAtCandidates.map((value) => toSafeNumber(value)))
            : referenceTimestamp;

    await TraceSettlementTask.updateOne(
        {
            conditionId,
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                conditionId,
                marketSlug: metadata.marketSlug,
                title: metadata.title,
                status: 'PENDING' as SettlementTaskStatus,
                reason: getConditionSettlementTaskReason(reason),
                resolvedStatus: resolution?.resolvedStatus || '',
                winnerOutcome: resolution?.winnerOutcome || '',
                sourceActivityId: mergedActivityIds[0],
                sourceActivityIds: mergedActivityIds,
                sourceActivityKeys: mergeStringArrays(
                    existingTask?.sourceActivityKeys || [],
                    orderedTrades.map((trade) => trade.activityKey || trade.transactionHash)
                ),
                sourceTransactionHash:
                    latestTrade?.transactionHash ||
                    existingTask?.sourceTransactionHash ||
                    getConditionSettlementExecutionKey(conditionId),
                sourceTransactionHashes: mergeStringArrays(
                    existingTask?.sourceTransactionHashes || [],
                    orderedTrades.map((trade) => trade.transactionHash)
                ),
                sourceTradeCount: mergedActivityIds.length,
                sourceTimestamp: Math.max(
                    toSafeNumber(existingTask?.sourceTimestamp),
                    referenceTimestamp
                ),
                sourceStartedAt,
                sourceEndedAt,
                nextRetryAt,
                claimedAt: 0,
                completedAt: 0,
            },
            $setOnInsert: {
                retryCount: 0,
                lastCheckedAt: 0,
            },
        },
        {
            upsert: true,
        }
    );
};

const finalizeConditionSettlementTask = async (params: {
    conditionId: string;
    status: Exclude<SettlementTaskStatus, 'PROCESSING'>;
    reason: string;
    resolution?: PolymarketMarketResolution | null;
    retryCount?: number;
    nextRetryAt?: number;
}) => {
    const { conditionId, status, reason, resolution, retryCount, nextRetryAt = 0 } = params;

    const nextState = {
        status,
        reason: getConditionSettlementTaskReason(reason),
        resolvedStatus: resolution?.resolvedStatus || '',
        winnerOutcome: resolution?.winnerOutcome || '',
        lastCheckedAt: Date.now(),
        nextRetryAt,
        claimedAt: 0,
        completedAt: status === 'PENDING' ? 0 : Date.now(),
    } as Record<string, number | string>;
    if (retryCount !== undefined) {
        nextState.retryCount = retryCount;
    }

    await TraceSettlementTask.updateOne(
        {
            conditionId,
        },
        {
            $set: nextState,
        }
    );
};

const readReadyConditionSettlementTasks = async () =>
    (await TraceSettlementTask.find({
        $or: [
            {
                status: 'PENDING',
                nextRetryAt: { $lte: Date.now() },
            },
            {
                status: 'PROCESSING',
                claimedAt: { $lt: buildLeaseCutoff() },
            },
        ],
    })
        .sort({ sourceTimestamp: 1, updatedAt: 1 })
        .exec()) as TraceSettlementTaskDocument[];

const loadConditionOutcomeKeys = async (
    conditionId: string,
    positions: Array<Pick<TracePositionInterface, 'asset' | 'outcomeIndex' | 'outcome'>>,
    triggerTrades: Array<Pick<UserActivityInterface, 'asset' | 'outcomeIndex' | 'outcome'>> = []
) => {
    const keys = new Set<string>();
    const registerOutcomeKey = (item: {
        asset?: string;
        outcomeIndex?: number;
        outcome?: string;
    }) => {
        const outcomeKey = buildConditionOutcomeKey(item);
        if (outcomeKey) {
            keys.add(outcomeKey);
        }
    };

    positions.forEach(registerOutcomeKey);
    triggerTrades.forEach(registerOutcomeKey);

    const sourceTrades = (await SourceActivity.find(
        {
            conditionId,
            asset: { $exists: true, $ne: '' },
        },
        {
            asset: 1,
            outcomeIndex: 1,
            outcome: 1,
        }
    )
        .limit(16)
        .exec()) as Array<Pick<UserActivityInterface, 'asset' | 'outcomeIndex' | 'outcome'>>;
    sourceTrades.forEach(registerOutcomeKey);

    return [...keys];
};

const computeLocalConditionMergeableSize = (
    positions: Array<Pick<TracePositionInterface, 'asset' | 'outcomeIndex' | 'outcome' | 'size'>>,
    outcomeKeys: string[]
) => {
    const sizeByOutcomeKey = new Map<string, number>();
    for (const position of positions) {
        const outcomeKey = buildConditionOutcomeKey(position);
        if (!outcomeKey) {
            continue;
        }

        sizeByOutcomeKey.set(outcomeKey, Math.max(toSafeNumber(position.size), 0));
    }

    return computeConditionMergeableSize(outcomeKeys, sizeByOutcomeKey);
};

const simulateTradeAgainstMarket = async (params: {
    portfolio: TracePortfolioDocument;
    position: TracePositionDocument;
    trade: UserActivityInterface;
    userPosition: { size?: number } | undefined;
    condition: string;
    marketStream: ClobMarketStream;
    executionTarget?: ExecutionTargetOverrides;
}) => {
    const { portfolio, position, trade, userPosition, condition, marketStream, executionTarget } =
        params;
    const marketSnapshot = await marketStream.getSnapshot(trade.asset);
    if (!marketSnapshot) {
        throw new RetryableTraceError('市场快照不可用');
    }

    const workingSnapshot = cloneMarketSnapshot(marketSnapshot);
    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const positionSizeBefore = toSafeNumber(position.size);
    let remainingRequestedUsdc: number | undefined;
    let remainingRequestedSize: number | undefined;
    let totalExecutedUsdc = 0;
    let totalExecutedSize = 0;
    let totalRealizedPnlDelta = 0;
    let lastExecutionPrice = Math.max(
        toSafeNumber(executionTarget?.sourcePrice),
        toSafeNumber(trade.price)
    );
    let finalReason = '';

    position.conditionId = trade.conditionId;
    position.marketSlug = String(trade.eventSlug || trade.slug || position.marketSlug || '').trim();
    position.title = trade.title;
    position.outcome = trade.outcome;
    position.outcomeIndex = Number.isFinite(trade.outcomeIndex)
        ? trade.outcomeIndex
        : position.outcomeIndex;
    position.side = trade.side;
    position.lastSourceTransactionHash = trade.transactionHash;
    position.lastTradedAt = trade.timestamp;
    position.closedAt = undefined;

    while (true) {
        const plan = buildChunkExecutionPlan({
            condition,
            trade,
            myPositionSize: Math.max(toSafeNumber(position.size), 0),
            sourcePositionAfterTradeSize: Math.max(toSafeNumber(userPosition?.size), 0),
            availableBalance: Math.max(toSafeNumber(portfolio.cashBalance), 0),
            sourceBalanceAfterTrade: Math.max(toSafeNumber(trade.sourceBalanceAfterTrade), 0),
            marketSnapshot: workingSnapshot,
            remainingRequestedUsdc,
            remainingRequestedSize,
            requestedUsdcOverride: executionTarget?.requestedUsdc,
            requestedSizeOverride: executionTarget?.requestedSize,
            sourcePriceOverride: executionTarget?.sourcePrice,
            noteOverride: executionTarget?.note,
        });

        if (plan.note) {
            finalReason = plan.note;
        }

        if (plan.status !== 'READY') {
            if (totalExecutedSize <= 0) {
                if (plan.status === 'RETRYABLE_ERROR') {
                    throw new RetryableTraceError(plan.reason);
                }

                updatePositionMark(position, lastExecutionPrice);
                if (!position.isNew || position.size > 0) {
                    await position.save();
                }

                return {
                    result: {
                        status: 'SKIPPED',
                        reason: mergeReasons(finalReason, plan.reason),
                        requestedSize: plan.requestedSize,
                        executedSize: 0,
                        requestedUsdc: plan.requestedUsdc,
                        executedUsdc: 0,
                        executionPrice: plan.executionPrice,
                        cashBefore,
                        cashAfter: cashBefore,
                        positionSizeBefore,
                        positionSizeAfter: positionSizeBefore,
                        realizedPnlDelta: 0,
                        unrealizedPnlAfter: toSafeNumber(position.unrealizedPnl),
                    } satisfies ExecutionResult,
                    position,
                };
            }

            finalReason = mergeReasons(finalReason, plan.reason);
            break;
        }

        lastExecutionPrice = plan.executionPrice;
        if (plan.side === 'BUY') {
            const executedUsdc = plan.orderAmount;
            const executedSize = executedUsdc / plan.executionPrice;

            portfolio.cashBalance = toSafeNumber(portfolio.cashBalance) - executedUsdc;
            position.size = normalizeSize(toSafeNumber(position.size) + executedSize);
            position.costBasis = toSafeNumber(position.costBasis) + executedUsdc;
            position.totalBoughtSize = toSafeNumber(position.totalBoughtSize) + executedSize;
            position.totalBoughtUsdc = toSafeNumber(position.totalBoughtUsdc) + executedUsdc;

            totalExecutedUsdc += executedUsdc;
            totalExecutedSize += executedSize;
            remainingRequestedUsdc = Math.max(
                (remainingRequestedUsdc ?? plan.requestedUsdc) - executedUsdc,
                0
            );
            consumeMarketLiquidity(workingSnapshot, Side.BUY, executedUsdc, plan.executionPrice);

            if (remainingRequestedUsdc <= 0) {
                break;
            }
        } else {
            const positionSizeBeforeChunk = Math.max(toSafeNumber(position.size), 0);
            const executedSize = plan.orderAmount;
            const costBasisReleased =
                positionSizeBeforeChunk > 0
                    ? toSafeNumber(position.costBasis) * (executedSize / positionSizeBeforeChunk)
                    : 0;
            const executedUsdc = executedSize * plan.executionPrice;
            const realizedPnlDelta = executedUsdc - costBasisReleased;

            portfolio.cashBalance = toSafeNumber(portfolio.cashBalance) + executedUsdc;
            portfolio.realizedPnl = toSafeNumber(portfolio.realizedPnl) + realizedPnlDelta;

            position.size = normalizeSize(positionSizeBeforeChunk - executedSize);
            position.costBasis = normalizeSize(
                toSafeNumber(position.costBasis) - costBasisReleased
            );
            position.realizedPnl = toSafeNumber(position.realizedPnl) + realizedPnlDelta;
            position.totalSoldSize = toSafeNumber(position.totalSoldSize) + executedSize;
            position.totalSoldUsdc = toSafeNumber(position.totalSoldUsdc) + executedUsdc;

            totalExecutedUsdc += executedUsdc;
            totalExecutedSize += executedSize;
            totalRealizedPnlDelta += realizedPnlDelta;
            remainingRequestedSize = Math.max(
                (remainingRequestedSize ?? plan.requestedSize) - executedSize,
                0
            );
            consumeMarketLiquidity(workingSnapshot, Side.SELL, executedSize, plan.executionPrice);

            if (remainingRequestedSize <= 0) {
                break;
            }
        }
    }

    if (position.size === 0) {
        position.costBasis = 0;
        position.avgPrice = 0;
        position.closedAt = trade.timestamp;
    }

    updatePositionMark(position, lastExecutionPrice);
    await position.save();

    return {
        result: {
            status: 'FILLED',
            reason: finalReason,
            requestedSize:
                condition === 'buy'
                    ? Math.max(
                          totalExecutedSize,
                          (executionTarget?.requestedUsdc || 0) /
                              Math.max(lastExecutionPrice, EPSILON)
                      )
                    : executionTarget?.requestedSize !== undefined
                      ? executionTarget.requestedSize
                      : totalExecutedSize + Math.max(remainingRequestedSize || 0, 0),
            executedSize: totalExecutedSize,
            requestedUsdc:
                condition === 'buy'
                    ? executionTarget?.requestedUsdc !== undefined
                        ? executionTarget.requestedUsdc
                        : totalExecutedUsdc + Math.max(remainingRequestedUsdc || 0, 0)
                    : totalExecutedUsdc +
                      Math.max(remainingRequestedSize || 0, 0) * Math.max(lastExecutionPrice, 0),
            executedUsdc: totalExecutedUsdc,
            executionPrice: lastExecutionPrice,
            cashBefore,
            cashAfter: toSafeNumber(portfolio.cashBalance),
            positionSizeBefore,
            positionSizeAfter: toSafeNumber(position.size),
            realizedPnlDelta: totalRealizedPnlDelta,
            unrealizedPnlAfter: toSafeNumber(position.unrealizedPnl),
        } satisfies ExecutionResult,
        position,
    };
};

const syncPortfolioAfterExecution = async (
    portfolio: TracePortfolioDocument,
    execution: {
        referenceHash: string;
        timestamp: number;
    },
    status: ExecutionStatus
) => {
    const metrics = await collectPortfolioMetrics(portfolio);

    applyPortfolioMetrics(portfolio, metrics);
    portfolio.totalExecutions = toSafeNumber(portfolio.totalExecutions) + 1;
    portfolio.filledExecutions =
        toSafeNumber(portfolio.filledExecutions) + (status === 'FILLED' ? 1 : 0);
    portfolio.skippedExecutions =
        toSafeNumber(portfolio.skippedExecutions) + (status === 'FILLED' ? 0 : 1);
    portfolio.lastSourceTransactionHash = execution.referenceHash;
    portfolio.lastUpdatedAt = execution.timestamp;

    await portfolio.save();

    return metrics;
};

const attachTriggerTradesToConditionExecution = async (
    executionKey: string,
    triggerTrades: UserActivityInterface[]
) => {
    if (triggerTrades.length === 0) {
        return false;
    }

    const existingExecution = (await TraceExecution.findOne(
        { sourceActivityKey: executionKey },
        {
            sourceActivityId: 1,
            sourceActivityIds: 1,
            sourceActivityKeys: 1,
            sourceTransactionHashes: 1,
            sourceStartedAt: 1,
            sourceEndedAt: 1,
            sourceTimestamp: 1,
        }
    ).exec()) as {
        sourceActivityId?: UserActivityInterface['_id'];
        sourceActivityIds?: UserActivityInterface['_id'][];
        sourceActivityKeys?: string[];
        sourceTransactionHashes?: string[];
        sourceStartedAt?: number;
        sourceEndedAt?: number;
        sourceTimestamp?: number;
    } | null;
    if (!existingExecution) {
        return false;
    }

    const orderedTrades = sortTradesAsc(triggerTrades);
    const latestTrade = orderedTrades[orderedTrades.length - 1];
    const firstTrade = orderedTrades[0];
    const mergedActivityIds = mergeActivityIds(
        existingExecution.sourceActivityId ? [existingExecution.sourceActivityId] : [],
        existingExecution.sourceActivityIds || [],
        orderedTrades.map((trade) => trade._id)
    );

    await TraceExecution.updateOne(
        { sourceActivityKey: executionKey },
        {
            $set: {
                sourceActivityId: mergedActivityIds[0],
                sourceActivityIds: mergedActivityIds,
                sourceActivityKeys: mergeStringArrays(
                    existingExecution.sourceActivityKeys || [],
                    orderedTrades.map((trade) => trade.activityKey || trade.transactionHash)
                ),
                sourceTransactionHash: latestTrade?.transactionHash || executionKey,
                sourceTransactionHashes: mergeStringArrays(
                    existingExecution.sourceTransactionHashes || [],
                    orderedTrades.map((trade) => trade.transactionHash)
                ),
                sourceTradeCount: mergedActivityIds.length,
                sourceTimestamp: Math.max(
                    toSafeNumber(existingExecution.sourceTimestamp),
                    toSafeNumber(latestTrade?.timestamp)
                ),
                sourceStartedAt: Math.min(
                    toSafeNumber(existingExecution.sourceStartedAt, Number.MAX_SAFE_INTEGER),
                    toSafeNumber(firstTrade?.timestamp, Number.MAX_SAFE_INTEGER)
                ),
                sourceEndedAt: Math.max(
                    toSafeNumber(existingExecution.sourceEndedAt),
                    toSafeNumber(latestTrade?.timestamp)
                ),
            },
        }
    );

    return true;
};

const recordSkippedConditionTrigger = async (params: {
    portfolio: TracePortfolioDocument;
    trade: UserActivityInterface;
    reason: string;
    positionSizeBefore: number;
    metadata: ConditionMetadata;
    resolution: PolymarketMarketResolution | null;
}) => {
    const { portfolio, trade, reason, positionSizeBefore, metadata, resolution } = params;
    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const completedAt = Date.now();

    await syncPortfolioAfterExecution(
        portfolio,
        {
            referenceHash: trade.transactionHash,
            timestamp: trade.timestamp,
        },
        'SKIPPED'
    );

    await TraceExecution.updateOne(
        {
            sourceActivityKey: getConditionTriggerExecutionKey(trade),
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: trade._id,
                sourceActivityIds: [trade._id],
                sourceActivityKey: getConditionTriggerExecutionKey(trade),
                sourceActivityKeys: [trade.activityKey || trade.transactionHash],
                sourceTransactionHash: trade.transactionHash,
                sourceTransactionHashes: [trade.transactionHash],
                sourceTradeCount: 1,
                sourceTimestamp: trade.timestamp,
                sourceStartedAt: trade.timestamp,
                sourceEndedAt: trade.timestamp,
                sourceSide: trade.type || trade.side || 'SETTLE',
                executionCondition: 'reconcile',
                status: 'SKIPPED',
                reason,
                asset: '',
                conditionId: trade.conditionId,
                marketSlug: metadata.marketSlug,
                title: metadata.title || trade.title,
                outcome: '',
                winnerOutcome: resolution?.winnerOutcome || '',
                requestedSize: positionSizeBefore,
                executedSize: 0,
                requestedUsdc: 0,
                executedUsdc: 0,
                executionPrice: 0,
                cashBefore,
                cashAfter: toSafeNumber(portfolio.cashBalance),
                positionSizeBefore,
                positionSizeAfter: positionSizeBefore,
                realizedPnlDelta: 0,
                realizedPnlTotal: toSafeNumber(portfolio.realizedPnl),
                unrealizedPnlAfter: toSafeNumber(portfolio.unrealizedPnl),
                totalEquityAfter: toSafeNumber(portfolio.totalEquity),
                claimedAt: completedAt,
                completedAt,
            },
        },
        {
            upsert: true,
        }
    );
};

const settleTraceCondition = async (params: {
    portfolio: TracePortfolioDocument;
    conditionId: string;
    positions?: TracePositionDocument[];
    triggerTrades?: UserActivityInterface[];
    metadata?: ConditionMetadata;
    forceResolutionRefresh?: boolean;
}): Promise<ConditionSettlementOutcome> => {
    const { portfolio, conditionId } = params;
    const effectiveTriggerTrades =
        params.triggerTrades && params.triggerTrades.length > 0
            ? sortTradesAsc(params.triggerTrades)
            : sortTradesAsc(await loadConditionSettlementTriggerTrades(conditionId));
    const settlementExecutionKey = getConditionSettlementExecutionKey(conditionId);
    if (
        await attachTriggerTradesToConditionExecution(
            settlementExecutionKey,
            effectiveTriggerTrades
        )
    ) {
        await finalizeConditionSettlementTask({
            conditionId,
            status: 'SETTLED',
            reason: 'condition 已完成结算，已补挂 source activity 关联',
        });
        await cancelResolvedConditionOpenWork({
            portfolio,
            conditionId,
            reason: 'condition 已完成结算，已停止后续盘口模拟',
        });
        return {
            status: 'FILLED',
            reason: 'condition 已完成结算，已补挂 source activity 关联',
            resolution: null,
        };
    }

    const positions =
        params.positions ||
        ((await TracePosition.find({
            conditionId,
            size: { $gt: 0 },
        }).exec()) as TracePositionDocument[]);
    if (positions.length === 0) {
        return {
            status: 'SKIPPED',
            reason: '本地无可结算的未平仓位',
            resolution: null,
        };
    }

    const metadata =
        params.metadata ||
        (await resolveConditionMetadata(conditionId, positions, effectiveTriggerTrades));
    const resolution = await loadConditionResolution(metadata, {
        forceRefresh: params.forceResolutionRefresh,
    });
    if (!isResolvedPolymarketMarket(resolution)) {
        return {
            status: 'SKIPPED',
            reason: '市场尚未 resolved 或缺少 winner，暂不执行 condition 级结算',
            resolution,
        };
    }

    const winnerOutcome = normalizeOutcomeLabel(resolution?.winnerOutcome || '');
    const totalPositionSizeBefore = positions.reduce(
        (sum, position) => sum + toSafeNumber(position.size),
        0
    );
    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const settledAt = Date.now();
    const latestTriggerTrade = effectiveTriggerTrades[effectiveTriggerTrades.length - 1];
    const firstTriggerTrade = effectiveTriggerTrades[0];

    let totalExecutedUsdc = 0;
    let totalRealizedPnlDelta = 0;

    for (const tracePosition of positions) {
        const positionSizeBefore = toSafeNumber(tracePosition.size);
        if (positionSizeBefore <= 0) {
            continue;
        }

        const isWinningOutcome = normalizeOutcomeLabel(tracePosition.outcome) === winnerOutcome;
        const executedUsdc = isWinningOutcome ? positionSizeBefore * SETTLEMENT_PRICE : 0;
        const realizedPnlDelta = executedUsdc - toSafeNumber(tracePosition.costBasis);

        totalExecutedUsdc += executedUsdc;
        totalRealizedPnlDelta += realizedPnlDelta;

        tracePosition.marketSlug = metadata.marketSlug || tracePosition.marketSlug;
        tracePosition.marketPrice = isWinningOutcome ? SETTLEMENT_PRICE : 0;
        tracePosition.size = 0;
        tracePosition.costBasis = 0;
        tracePosition.marketValue = 0;
        tracePosition.avgPrice = 0;
        tracePosition.unrealizedPnl = 0;
        tracePosition.realizedPnl = toSafeNumber(tracePosition.realizedPnl) + realizedPnlDelta;
        tracePosition.lastSourceTransactionHash =
            latestTriggerTrade?.transactionHash || settlementExecutionKey;
        tracePosition.lastTradedAt = settledAt;
        tracePosition.closedAt = settledAt;
        await tracePosition.save();
    }

    portfolio.cashBalance = cashBefore + totalExecutedUsdc;
    portfolio.realizedPnl = toSafeNumber(portfolio.realizedPnl) + totalRealizedPnlDelta;

    await syncPortfolioAfterExecution(
        portfolio,
        {
            referenceHash: latestTriggerTrade?.transactionHash || settlementExecutionKey,
            timestamp: latestTriggerTrade?.timestamp || settledAt,
        },
        'FILLED'
    );

    const existingExecution = (await TraceExecution.findOne(
        { sourceActivityKey: settlementExecutionKey },
        {
            sourceActivityId: 1,
            sourceActivityIds: 1,
            sourceActivityKeys: 1,
            sourceTransactionHashes: 1,
        }
    ).exec()) as {
        sourceActivityId?: UserActivityInterface['_id'];
        sourceActivityIds?: UserActivityInterface['_id'][];
        sourceActivityKeys?: string[];
        sourceTransactionHashes?: string[];
    } | null;
    const mergedActivityIds = mergeActivityIds(
        existingExecution?.sourceActivityId ? [existingExecution.sourceActivityId] : [],
        existingExecution?.sourceActivityIds || [],
        effectiveTriggerTrades.map((trade) => trade._id)
    );

    await TraceExecution.updateOne(
        {
            sourceActivityKey: settlementExecutionKey,
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: mergedActivityIds[0],
                sourceActivityIds: mergedActivityIds,
                sourceActivityKey: settlementExecutionKey,
                sourceActivityKeys: mergeStringArrays(
                    existingExecution?.sourceActivityKeys || [],
                    effectiveTriggerTrades.map(
                        (trade) => trade.activityKey || trade.transactionHash
                    )
                ),
                sourceTransactionHash:
                    latestTriggerTrade?.transactionHash || settlementExecutionKey,
                sourceTransactionHashes: mergeStringArrays(
                    existingExecution?.sourceTransactionHashes || [],
                    effectiveTriggerTrades.map((trade) => trade.transactionHash)
                ),
                sourceTradeCount: mergedActivityIds.length,
                sourceTimestamp: latestTriggerTrade?.timestamp || settledAt,
                sourceStartedAt: firstTriggerTrade?.timestamp || settledAt,
                sourceEndedAt: latestTriggerTrade?.timestamp || settledAt,
                sourceSide: latestTriggerTrade?.type || 'SETTLE',
                executionCondition: 'settle',
                status: 'FILLED',
                reason: `根据市场 resolved winner=${resolution?.winnerOutcome || 'unknown'} 自动执行 condition 级结算`,
                asset: '',
                conditionId,
                marketSlug: metadata.marketSlug,
                title: metadata.title || resolution?.title || positions[0]?.title || '',
                outcome: resolution?.winnerOutcome || '',
                winnerOutcome: resolution?.winnerOutcome || '',
                requestedSize: totalPositionSizeBefore,
                executedSize: totalPositionSizeBefore,
                requestedUsdc: totalExecutedUsdc,
                executedUsdc: totalExecutedUsdc,
                executionPrice:
                    totalPositionSizeBefore > 0 ? totalExecutedUsdc / totalPositionSizeBefore : 0,
                cashBefore,
                cashAfter: toSafeNumber(portfolio.cashBalance),
                positionSizeBefore: totalPositionSizeBefore,
                positionSizeAfter: 0,
                realizedPnlDelta: totalRealizedPnlDelta,
                realizedPnlTotal: toSafeNumber(portfolio.realizedPnl),
                unrealizedPnlAfter: toSafeNumber(portfolio.unrealizedPnl),
                totalEquityAfter: toSafeNumber(portfolio.totalEquity),
                claimedAt: settledAt,
                completedAt: settledAt,
            },
        },
        {
            upsert: true,
        }
    );

    await finalizeConditionSettlementTask({
        conditionId,
        status: 'SETTLED',
        reason: '已按 resolved winner 完成 condition 级结算',
        resolution,
        retryCount: 0,
        nextRetryAt: 0,
    });
    await cancelResolvedConditionOpenWork({
        portfolio,
        conditionId,
        reason: `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，已停止后续盘口模拟`,
    });

    logger.info(
        `condition=${conditionId} winner=${resolution?.winnerOutcome || 'unknown'} 自动结算 ` +
            `size=${formatAmount(totalPositionSizeBefore)} payout=${formatAmount(totalExecutedUsdc)}`
    );

    return {
        status: 'FILLED',
        reason: '已按 resolved winner 完成 condition 级结算',
        resolution,
        positionSizeBefore: totalPositionSizeBefore,
    };
};

const executeConditionMergeTrade = async (params: {
    portfolio: TracePortfolioDocument;
    trade: UserActivityInterface;
    positions: TracePositionDocument[];
    metadata: ConditionMetadata;
    resolution: PolymarketMarketResolution | null;
}): Promise<ConditionSettlementOutcome> => {
    const { portfolio, trade, positions, metadata, resolution } = params;
    const sourceMergeRequestedSize = Math.max(
        toSafeNumber(trade.size),
        toSafeNumber(trade.usdcSize)
    );
    const sourceMergeableBefore = Math.max(
        toSafeNumber(
            trade.sourceConditionMergeableSizeBeforeTrade,
            toSafeNumber(trade.sourceConditionMergeableSizeAfterTrade) + sourceMergeRequestedSize
        ),
        0
    );
    const outcomeKeys = await loadConditionOutcomeKeys(trade.conditionId, positions, [trade]);
    const localMergeableBefore = computeLocalConditionMergeableSize(positions, outcomeKeys);

    if (sourceMergeRequestedSize <= EPSILON) {
        return {
            status: 'SKIPPED',
            reason: '源 MERGE 数量无效，已跳过 condition 级 merge',
            resolution,
            positionSizeBefore: localMergeableBefore,
        };
    }

    if (sourceMergeableBefore <= EPSILON) {
        return {
            status: 'SKIPPED',
            reason: '缺少源账户 condition mergeable 快照，无法按比例复刻 MERGE',
            resolution,
            positionSizeBefore: localMergeableBefore,
        };
    }

    if (localMergeableBefore <= EPSILON) {
        return {
            status: 'SKIPPED',
            reason: '本地无可 merge 的 complete set',
            resolution,
            positionSizeBefore: 0,
        };
    }

    const mergeRatio = Math.min(sourceMergeRequestedSize / sourceMergeableBefore, 1);
    const localMergeRequestedSize = normalizeSize(localMergeableBefore * mergeRatio);
    if (localMergeRequestedSize <= EPSILON) {
        return {
            status: 'SKIPPED',
            reason: '按比例换算后的本地 merge 数量为 0',
            resolution,
            positionSizeBefore: localMergeableBefore,
        };
    }

    const participatingPositions = positions.filter((position) => {
        const outcomeKey = buildConditionOutcomeKey(position);
        return outcomeKey && outcomeKeys.includes(outcomeKey) && toSafeNumber(position.size) > 0;
    });
    if (participatingPositions.length < 2) {
        return {
            status: 'SKIPPED',
            reason: '本地缺少完整对手仓位，无法执行 condition 级 merge',
            resolution,
            positionSizeBefore: localMergeableBefore,
        };
    }

    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const proceedsShare = localMergeRequestedSize / participatingPositions.length;
    let totalRealizedPnlDelta = 0;

    for (const position of participatingPositions) {
        const positionSizeBefore = Math.max(toSafeNumber(position.size), 0);
        const releasedCostBasis =
            positionSizeBefore > 0
                ? toSafeNumber(position.costBasis) * (localMergeRequestedSize / positionSizeBefore)
                : 0;
        const realizedPnlDelta = proceedsShare - releasedCostBasis;

        position.size = normalizeSize(positionSizeBefore - localMergeRequestedSize);
        position.costBasis = normalizeSize(toSafeNumber(position.costBasis) - releasedCostBasis);
        position.realizedPnl = toSafeNumber(position.realizedPnl) + realizedPnlDelta;
        position.totalSoldSize = toSafeNumber(position.totalSoldSize) + localMergeRequestedSize;
        position.totalSoldUsdc = toSafeNumber(position.totalSoldUsdc) + proceedsShare;
        position.lastSourceTransactionHash = trade.transactionHash;
        position.lastTradedAt = trade.timestamp;

        if (position.size === 0) {
            position.avgPrice = 0;
            position.marketValue = 0;
            position.unrealizedPnl = 0;
            position.closedAt = trade.timestamp;
        } else {
            position.closedAt = undefined;
            updatePositionMark(position, toSafeNumber(position.marketPrice));
        }

        totalRealizedPnlDelta += realizedPnlDelta;
        await position.save();
    }

    portfolio.cashBalance = cashBefore + localMergeRequestedSize;
    portfolio.realizedPnl = toSafeNumber(portfolio.realizedPnl) + totalRealizedPnlDelta;

    await syncPortfolioAfterExecution(
        portfolio,
        {
            referenceHash: trade.transactionHash,
            timestamp: trade.timestamp,
        },
        'FILLED'
    );

    await TraceExecution.updateOne(
        {
            sourceActivityKey: getConditionTriggerExecutionKey(trade),
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: trade._id,
                sourceActivityIds: [trade._id],
                sourceActivityKey: getConditionTriggerExecutionKey(trade),
                sourceActivityKeys: [trade.activityKey || trade.transactionHash],
                sourceTransactionHash: trade.transactionHash,
                sourceTransactionHashes: [trade.transactionHash],
                sourceTradeCount: 1,
                sourceTimestamp: trade.timestamp,
                sourceStartedAt: trade.timestamp,
                sourceEndedAt: trade.timestamp,
                sourceSide: trade.type || 'MERGE',
                executionCondition: 'merge',
                status: 'FILLED',
                reason: `根据源账户 MERGE 比例 ${(mergeRatio * 100).toFixed(2)}% 执行 condition 级 complete-set merge`,
                asset: '',
                conditionId: trade.conditionId,
                marketSlug: metadata.marketSlug,
                title: metadata.title || trade.title,
                outcome: '',
                winnerOutcome: '',
                requestedSize: localMergeRequestedSize,
                executedSize: localMergeRequestedSize,
                requestedUsdc: localMergeRequestedSize,
                executedUsdc: localMergeRequestedSize,
                executionPrice: SETTLEMENT_PRICE,
                cashBefore,
                cashAfter: toSafeNumber(portfolio.cashBalance),
                positionSizeBefore: localMergeableBefore,
                positionSizeAfter: normalizeSize(localMergeableBefore - localMergeRequestedSize),
                realizedPnlDelta: totalRealizedPnlDelta,
                realizedPnlTotal: toSafeNumber(portfolio.realizedPnl),
                unrealizedPnlAfter: toSafeNumber(portfolio.unrealizedPnl),
                totalEquityAfter: toSafeNumber(portfolio.totalEquity),
                claimedAt: Date.now(),
                completedAt: Date.now(),
            },
        },
        {
            upsert: true,
        }
    );

    logger.info(
        `condition=${trade.conditionId} 已执行 condition 级 merge ` +
            `sourceMerge=${formatAmount(sourceMergeRequestedSize)} ` +
            `localMerge=${formatAmount(localMergeRequestedSize)}`
    );

    return {
        status: 'FILLED',
        reason: '已按源账户 MERGE 比例完成 condition 级 merge',
        resolution,
        positionSizeBefore: localMergeableBefore,
    };
};

const syncConditionSettlementTasksFromOpenPositions = async () => {
    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    const positionsByCondition = new Map<string, TracePositionDocument[]>();

    for (const position of activePositions) {
        const existingPositions = positionsByCondition.get(position.conditionId) || [];
        existingPositions.push(position);
        positionsByCondition.set(position.conditionId, existingPositions);
    }

    for (const [conditionId, positions] of positionsByCondition.entries()) {
        const metadata = await resolveConditionMetadata(conditionId, positions);
        await upsertConditionSettlementTask({
            conditionId,
            metadata,
            reason: '检测到本地仍有未平仓 condition，已加入待回补结算队列',
            nextRetryAt: 0,
        });
    }
};

const processReadyConditionSettlementTasks = async () => {
    const tasks = await readReadyConditionSettlementTasks();
    if (tasks.length === 0) {
        return;
    }

    const portfolio = await ensurePortfolio();
    for (const task of tasks) {
        await TraceSettlementTask.updateOne(
            {
                _id: task._id,
            },
            {
                $set: {
                    status: 'PROCESSING',
                    claimedAt: Date.now(),
                },
            }
        );

        try {
            const triggerTrades = await loadConditionSettlementTriggerTrades(task.conditionId);
            const activePositions = (await TracePosition.find({
                conditionId: task.conditionId,
                size: { $gt: 0 },
            }).exec()) as TracePositionDocument[];
            const metadata =
                task.marketSlug || task.title
                    ? {
                          conditionId: task.conditionId,
                          marketSlug: String(task.marketSlug || '').trim(),
                          title: String(task.title || '').trim(),
                      }
                    : await resolveConditionMetadata(
                          task.conditionId,
                          activePositions,
                          triggerTrades
                      );
            const outcome = await settleTraceCondition({
                portfolio,
                conditionId: task.conditionId,
                positions: activePositions,
                triggerTrades,
                metadata,
                forceResolutionRefresh: true,
            });

            if (outcome.status === 'FILLED') {
                continue;
            }

            if (outcome.reason === '本地无可结算的未平仓位') {
                await finalizeConditionSettlementTask({
                    conditionId: task.conditionId,
                    status: 'CLOSED',
                    reason: outcome.reason,
                    resolution: outcome.resolution,
                    retryCount: 0,
                    nextRetryAt: 0,
                });
                continue;
            }

            const nextRetryCount = toSafeNumber(task.retryCount) + 1;
            await finalizeConditionSettlementTask({
                conditionId: task.conditionId,
                status: 'PENDING',
                reason: outcome.reason,
                resolution: outcome.resolution,
                retryCount: nextRetryCount,
                nextRetryAt: Date.now() + buildConditionSettlementRetryDelayMs(nextRetryCount),
            });
        } catch (error) {
            const nextRetryCount = toSafeNumber(task.retryCount) + 1;
            const reason =
                error instanceof Error
                    ? `condition 级结算回补异常: ${error.message}`
                    : 'condition 级结算回补发生未知异常';
            await finalizeConditionSettlementTask({
                conditionId: task.conditionId,
                status: 'PENDING',
                reason,
                retryCount: nextRetryCount,
                nextRetryAt: Date.now() + buildConditionSettlementRetryDelayMs(nextRetryCount),
            });
            logger.warn(`condition=${task.conditionId} 结算回补稍后重试 reason=${reason}`);
        }
    }
};

const syncTracePortfolioWithPolymarket = async (portfolio: TracePortfolioDocument) => {
    const userPositions = await fetchSourcePositions();
    if (userPositions) {
        await refreshOpenPositionMarks(userPositions);
    }

    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    const positionsByCondition = new Map<string, TracePositionDocument[]>();
    for (const position of activePositions) {
        const conditionPositions = positionsByCondition.get(position.conditionId) || [];
        conditionPositions.push(position);
        positionsByCondition.set(position.conditionId, conditionPositions);
    }

    for (const [conditionId, positions] of positionsByCondition.entries()) {
        const metadata = await resolveConditionMetadata(conditionId, positions);
        const outcome = await settleTraceCondition({
            portfolio,
            conditionId,
            positions,
            metadata,
            forceResolutionRefresh: true,
        });

        if (outcome.status !== 'FILLED') {
            await upsertConditionSettlementTask({
                conditionId,
                metadata,
                reason: outcome.reason,
                resolution: outcome.resolution,
                nextRetryAt: 0,
            });
        }
    }

    await refreshPortfolioState(portfolio);
};

const readTrackedTradeIds = async () => {
    const [executions, buffers, batches] = await Promise.all([
        TraceExecution.find(
            {},
            {
                sourceActivityId: 1,
                sourceActivityIds: 1,
            }
        ).exec(),
        TraceIntentBuffer.find(
            {
                state: { $in: ['OPEN', 'FLUSHING'] },
            },
            {
                sourceTradeIds: 1,
            }
        ).exec(),
        TraceExecutionBatch.find(
            {
                status: { $in: ['READY', 'PROCESSING', 'SUBMITTED'] },
            },
            {
                sourceTradeIds: 1,
            }
        ).exec(),
    ]);

    const trackedIds = new Set<string>();
    for (const execution of executions as Array<{
        sourceActivityId?: UserActivityInterface['_id'];
        sourceActivityIds?: UserActivityInterface['_id'][];
    }>) {
        if (execution.sourceActivityId) {
            trackedIds.add(String(execution.sourceActivityId));
        }
        for (const tradeId of execution.sourceActivityIds || []) {
            trackedIds.add(String(tradeId));
        }
    }

    for (const buffer of buffers as Array<{ sourceTradeIds?: UserActivityInterface['_id'][] }>) {
        for (const tradeId of buffer.sourceTradeIds || []) {
            trackedIds.add(String(tradeId));
        }
    }

    for (const batch of batches as Array<{ sourceTradeIds?: UserActivityInterface['_id'][] }>) {
        for (const tradeId of batch.sourceTradeIds || []) {
            trackedIds.add(String(tradeId));
        }
    }

    return trackedIds;
};

const loadPendingTrades = async () => {
    const [trades, trackedIds] = await Promise.all([
        SourceActivity.find({
            $and: [
                { type: { $in: ['TRADE', 'MERGE', 'REDEEM'] } },
                { $or: [{ executionIntent: 'EXECUTE' }, { executionIntent: { $exists: false } }] },
                {
                    $or: [
                        { type: { $in: ['MERGE', 'REDEEM'] } },
                        { snapshotStatus: 'COMPLETE' },
                        { snapshotStatus: { $exists: false } },
                    ],
                },
                { transactionHash: { $exists: true, $ne: '' } },
            ],
        })
            .sort({ timestamp: 1 })
            .exec(),
        readTrackedTradeIds(),
    ]);

    return (trades as UserActivityInterface[]).filter(
        (trade) => !trackedIds.has(String(trade._id))
    );
};

const loadTradesByIds = async (tradeIds: UserActivityInterface['_id'][]) =>
    (await SourceActivity.find({
        _id: {
            $in: tradeIds,
        },
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];

const loadExistingPosition = async (trade: UserActivityInterface) =>
    ((await TracePosition.findOne({
        asset: trade.asset,
    }).exec()) as TracePositionDocument | null) || createEmptyPosition(trade);

const readFlushableBuffers = async () =>
    (await TraceIntentBuffer.find({
        $or: [
            {
                state: 'OPEN',
                flushAfter: { $lte: Date.now() },
            },
            {
                state: 'FLUSHING',
                claimedAt: { $lt: buildLeaseCutoff() },
            },
        ],
    })
        .sort({ flushAfter: 1, sourceStartedAt: 1 })
        .exec()) as CopyIntentBufferInterface[];

const readReadyBatches = async () =>
    (await TraceExecutionBatch.find({
        $or: [
            {
                status: 'READY',
            },
            {
                status: 'PROCESSING',
                claimedAt: { $lt: buildLeaseCutoff() },
            },
        ],
    })
        .sort({ sourceStartedAt: 1, createdAt: 1 })
        .exec()) as CopyExecutionBatchInterface[];

const recordTraceExecution = async (params: {
    executionKey: string;
    trades: UserActivityInterface[];
    condition: string;
    result: ExecutionResult;
    portfolio: TracePortfolioDocument;
    sourceSide: string;
    copyIntentBufferId?: CopyIntentBufferInterface['_id'];
    copyExecutionBatchId?: CopyExecutionBatchInterface['_id'];
    policyTrail?: ExecutionPolicyTrailEntry[];
}) => {
    const {
        executionKey,
        trades,
        condition,
        result,
        portfolio,
        sourceSide,
        copyIntentBufferId,
        copyExecutionBatchId,
        policyTrail,
    } = params;
    const orderedTrades = sortTradesAsc(trades);
    const firstTrade = orderedTrades[0];
    const lastTrade = orderedTrades[orderedTrades.length - 1];
    if (!firstTrade || !lastTrade) {
        return;
    }

    await TraceExecution.updateOne(
        {
            sourceActivityKey: executionKey,
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: firstTrade._id,
                sourceActivityIds: orderedTrades.map((trade) => trade._id),
                sourceActivityKey: executionKey,
                sourceActivityKeys: orderedTrades.map(
                    (trade) => trade.activityKey || trade.transactionHash
                ),
                sourceTransactionHash: lastTrade.transactionHash,
                sourceTransactionHashes: orderedTrades.map((trade) => trade.transactionHash),
                sourceTradeCount: orderedTrades.length,
                sourceTimestamp: lastTrade.timestamp,
                sourceStartedAt: firstTrade.timestamp,
                sourceEndedAt: lastTrade.timestamp,
                sourceSide,
                executionCondition: condition,
                status: result.status,
                reason: result.reason,
                asset: lastTrade.asset,
                conditionId: lastTrade.conditionId,
                marketSlug: String(lastTrade.eventSlug || lastTrade.slug || '').trim(),
                title: lastTrade.title,
                outcome: lastTrade.outcome,
                winnerOutcome: '',
                requestedSize: result.requestedSize,
                executedSize: result.executedSize,
                requestedUsdc: result.requestedUsdc,
                executedUsdc: result.executedUsdc,
                executionPrice: result.executionPrice,
                cashBefore: result.cashBefore,
                cashAfter: result.cashAfter,
                positionSizeBefore: result.positionSizeBefore,
                positionSizeAfter: result.positionSizeAfter,
                realizedPnlDelta: result.realizedPnlDelta,
                realizedPnlTotal: toSafeNumber(portfolio.realizedPnl),
                unrealizedPnlAfter: toSafeNumber(portfolio.unrealizedPnl),
                totalEquityAfter: toSafeNumber(portfolio.totalEquity),
                copyIntentBufferId,
                copyExecutionBatchId,
                policyTrail: policyTrail || [],
                completedAt: Date.now(),
            },
        },
        {
            upsert: true,
        }
    );
};

const validateTradeForTrace = (trade: UserActivityInterface) => {
    if (trade.snapshotStatus && trade.snapshotStatus !== 'COMPLETE') {
        return {
            status: 'RETRY' as const,
            reason: trade.sourceSnapshotReason || '源账户快照尚未完整',
        };
    }

    if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
        return {
            status: 'RETRY' as const,
            reason: '缺少源账户持仓快照',
        };
    }

    if (
        String(trade.side || '').toUpperCase() === 'BUY' &&
        !Number.isFinite(trade.sourceBalanceAfterTrade)
    ) {
        return {
            status: 'RETRY' as const,
            reason: '缺少源账户余额快照',
        };
    }

    return {
        status: 'OK' as const,
        reason: '',
    };
};

const appendTradeToBuyBuffer = async (trade: UserActivityInterface) => {
    const bufferKey = buildBuyBufferKey(trade);
    const trail = [
        buildPolicyTrailEntry('source-trade-merge', 'DEFER', '已加入模拟买单累计缓冲区'),
    ];
    const existingBuffer = (await TraceIntentBuffer.findOne({
        bufferKey,
        state: 'OPEN',
    }).exec()) as CopyIntentBufferInterface | null;

    if (!existingBuffer) {
        await TraceIntentBuffer.create({
            sourceWallet: USER_ADDRESS,
            bufferKey,
            state: 'OPEN',
            condition: 'buy',
            asset: trade.asset,
            conditionId: trade.conditionId,
            title: trade.title,
            outcome: trade.outcome,
            side: trade.side,
            sourceTradeIds: [trade._id],
            sourceActivityKeys: [trade.activityKey || trade.transactionHash],
            sourceTransactionHashes: [trade.transactionHash],
            sourceTradeCount: 1,
            sourceStartedAt: trade.timestamp,
            sourceEndedAt: trade.timestamp,
            flushAfter: buildBuyBufferFlushAfter(trade.timestamp),
            expireAt: buildBuyBufferExpireAt(trade.timestamp),
            claimedAt: 0,
            reason: '已加入模拟买单累计缓冲区',
            policyTrail: trail,
            completedAt: 0,
        });
        return;
    }

    await TraceIntentBuffer.updateOne(
        {
            _id: existingBuffer._id,
        },
        {
            $set: {
                sourceEndedAt: trade.timestamp,
                flushAfter: buildBuyBufferFlushAfter(trade.timestamp),
                expireAt: Math.max(
                    toSafeNumber(existingBuffer.expireAt),
                    buildBuyBufferExpireAt(trade.timestamp)
                ),
                title: trade.title,
                outcome: trade.outcome,
                side: trade.side,
                reason: '已加入模拟买单累计缓冲区',
                policyTrail: mergePolicyTrail(existingBuffer.policyTrail, trail),
            },
            $push: {
                sourceTradeIds: trade._id,
                sourceActivityKeys: trade.activityKey || trade.transactionHash,
                sourceTransactionHashes: trade.transactionHash,
            },
            $inc: {
                sourceTradeCount: 1,
            },
        }
    );
};

const createSkippedTraceResult = (
    portfolio: TracePortfolioDocument,
    position: TracePositionDocument,
    reason: string,
    requestedUsdc = 0,
    requestedSize = 0,
    executionPrice = 0
): ExecutionResult => ({
    status: 'SKIPPED',
    reason,
    requestedSize,
    executedSize: 0,
    requestedUsdc,
    executedUsdc: 0,
    executionPrice,
    cashBefore: toSafeNumber(portfolio.cashBalance),
    cashAfter: toSafeNumber(portfolio.cashBalance),
    positionSizeBefore: toSafeNumber(position.size),
    positionSizeAfter: toSafeNumber(position.size),
    realizedPnlDelta: 0,
    unrealizedPnlAfter: toSafeNumber(position.unrealizedPnl),
});

const createPortfolioOnlySkippedResult = (
    portfolio: TracePortfolioDocument,
    reason: string,
    requestedUsdc = 0,
    requestedSize = 0,
    executionPrice = 0
): ExecutionResult => ({
    status: 'SKIPPED',
    reason,
    requestedSize,
    executedSize: 0,
    requestedUsdc,
    executedUsdc: 0,
    executionPrice,
    cashBefore: toSafeNumber(portfolio.cashBalance),
    cashAfter: toSafeNumber(portfolio.cashBalance),
    positionSizeBefore: 0,
    positionSizeAfter: 0,
    realizedPnlDelta: 0,
    unrealizedPnlAfter: toSafeNumber(portfolio.unrealizedPnl),
});

const cancelResolvedConditionOpenWork = async (params: {
    portfolio: TracePortfolioDocument;
    conditionId: string;
    reason: string;
}) => {
    const { portfolio, conditionId, reason } = params;
    const [openBuffers, openBatches] = await Promise.all([
        TraceIntentBuffer.find({
            conditionId,
            state: { $in: ['OPEN', 'FLUSHING'] },
        }).exec() as Promise<CopyIntentBufferInterface[]>,
        TraceExecutionBatch.find({
            conditionId,
            status: { $in: ['READY', 'PROCESSING'] },
        }).exec() as Promise<CopyExecutionBatchInterface[]>,
    ]);
    const resolutionTrail = [buildPolicyTrailEntry('resolved-condition-guard', 'SKIP', reason)];

    for (const buffer of openBuffers) {
        const trades = await loadTradesByIds(buffer.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        const policyTrail = mergePolicyTrail(buffer.policyTrail, resolutionTrail);

        await recordTraceExecution({
            executionKey: `buffer:${String(buffer._id)}`,
            trades,
            condition: 'reconcile',
            result: createPortfolioOnlySkippedResult(
                portfolio,
                reason,
                0,
                0,
                Math.max(toSafeNumber(latestTrade?.price), 0)
            ),
            portfolio,
            sourceSide: latestTrade?.side || buffer.side || 'BUY',
            copyIntentBufferId: buffer._id,
            policyTrail,
        });

        await TraceIntentBuffer.updateOne(
            { _id: buffer._id },
            {
                $set: {
                    state: 'SKIPPED',
                    claimedAt: 0,
                    reason,
                    policyTrail,
                    completedAt: Date.now(),
                },
            }
        );
    }

    for (const batch of openBatches) {
        const trades = await loadTradesByIds(batch.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        const policyTrail = mergePolicyTrail(batch.policyTrail, resolutionTrail);

        await recordTraceExecution({
            executionKey: getBatchExecutionKey(batch._id),
            trades,
            condition: 'reconcile',
            result: createPortfolioOnlySkippedResult(
                portfolio,
                reason,
                batch.requestedUsdc,
                batch.requestedSize,
                batch.sourcePrice
            ),
            portfolio,
            sourceSide: latestTrade?.side || batch.side || '',
            copyIntentBufferId: batch.bufferId,
            copyExecutionBatchId: batch._id,
            policyTrail,
        });

        await TraceExecutionBatch.updateOne(
            { _id: batch._id },
            {
                $set: {
                    status: 'SKIPPED',
                    reason,
                    claimedAt: 0,
                    completedAt: Date.now(),
                    policyTrail,
                },
            }
        );
    }
};

const sweepResolvedConditionOpenWork = async () => {
    const [openBuffers, openBatches] = await Promise.all([
        TraceIntentBuffer.find({
            state: { $in: ['OPEN', 'FLUSHING'] },
            conditionId: { $exists: true, $ne: '' },
        }).exec() as Promise<CopyIntentBufferInterface[]>,
        TraceExecutionBatch.find({
            status: { $in: ['READY', 'PROCESSING'] },
            conditionId: { $exists: true, $ne: '' },
        }).exec() as Promise<CopyExecutionBatchInterface[]>,
    ]);
    const titlesByCondition = new Map<string, string>();
    let portfolio: TracePortfolioDocument | null = null;

    for (const item of [...openBuffers, ...openBatches]) {
        if (!titlesByCondition.has(item.conditionId)) {
            titlesByCondition.set(item.conditionId, String(item.title || '').trim());
        }
    }

    for (const [conditionId, title] of titlesByCondition.entries()) {
        const activePositions = (await TracePosition.find({
            conditionId,
            size: { $gt: 0 },
        }).exec()) as TracePositionDocument[];
        const metadata =
            title || activePositions.length > 0
                ? await resolveConditionMetadata(conditionId, activePositions, [
                      {
                          conditionId,
                          title,
                          slug: buildPolymarketMarketSlugFromTitle(title),
                          eventSlug: buildPolymarketMarketSlugFromTitle(title),
                      } as Pick<
                          UserActivityInterface,
                          'conditionId' | 'title' | 'slug' | 'eventSlug'
                      >,
                  ])
                : await resolveConditionMetadata(conditionId, activePositions);
        const resolution = await loadConditionResolution(metadata, {
            forceRefresh: true,
        });

        if (!isResolvedPolymarketMarket(resolution)) {
            continue;
        }

        portfolio = portfolio || (await ensurePortfolio());
        await cancelResolvedConditionOpenWork({
            portfolio,
            conditionId,
            reason: `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，已停止后续盘口模拟`,
        });
    }
};

const finalizeSkippedBuffer = async (
    buffer: CopyIntentBufferInterface,
    trades: UserActivityInterface[],
    reason: string,
    policyTrail: ExecutionPolicyTrailEntry[]
) => {
    const portfolio = await ensurePortfolio();
    const latestTrade = sortTradesAsc(trades).slice(-1)[0];
    if (!latestTrade) {
        return;
    }
    const position = await loadExistingPosition(latestTrade);
    updatePositionMark(position, toSafeNumber(latestTrade.price));
    if (!position.isNew || position.size > 0) {
        await position.save();
    }

    const result = createSkippedTraceResult(
        portfolio,
        position,
        reason,
        0,
        0,
        toSafeNumber(latestTrade.price)
    );
    await syncPortfolioAfterExecution(
        portfolio,
        {
            referenceHash: trades[trades.length - 1]?.transactionHash || '',
            timestamp: latestTrade.timestamp,
        },
        result.status
    );
    await recordTraceExecution({
        executionKey: `buffer:${String(buffer._id)}`,
        trades,
        condition: 'buy',
        result,
        portfolio,
        sourceSide: latestTrade.side,
        copyIntentBufferId: buffer._id,
        policyTrail,
    });
    await TraceIntentBuffer.updateOne(
        { _id: buffer._id },
        {
            $set: {
                state: 'SKIPPED',
                reason,
                policyTrail,
                claimedAt: 0,
                completedAt: Date.now(),
            },
        }
    );
};

const cancelOpenBuyBuffersForAsset = async (
    trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
) => {
    const buffers = (await TraceIntentBuffer.find({
        state: 'OPEN',
        condition: 'buy',
        asset: trade.asset,
    }).exec()) as CopyIntentBufferInterface[];

    for (const buffer of buffers) {
        const trades = await loadTradesByIds(buffer.sourceTradeIds);
        if (trades.length === 0) {
            await TraceIntentBuffer.updateOne(
                { _id: buffer._id },
                {
                    $set: {
                        state: 'SKIPPED',
                        reason: '累计缓冲缺少关联源交易',
                        completedAt: Date.now(),
                    },
                }
            );
            continue;
        }

        const trail = mergePolicyTrail(buffer.policyTrail, [
            buildPolicyTrailEntry(
                'source-trade-merge',
                'SKIP',
                `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已关闭模拟累计缓冲`
            ),
        ]);
        await finalizeSkippedBuffer(
            buffer,
            trades,
            `检测到 asset=${trade.asset} 的非买入源交易，已放弃未执行的累计买单`,
            trail
        );
    }
};

const cancelReadyBuyBatchesForAsset = async (
    trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
) => {
    const batches = (await TraceExecutionBatch.find({
        status: 'READY',
        condition: 'buy',
        asset: trade.asset,
    }).exec()) as CopyExecutionBatchInterface[];

    for (const batch of batches) {
        const trades = await loadTradesByIds(batch.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        if (!latestTrade) {
            await TraceExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: {
                        status: 'SKIPPED',
                        reason: '执行批次缺少关联源交易',
                        completedAt: Date.now(),
                    },
                }
            );
            continue;
        }

        const portfolio = await ensurePortfolio();
        const position = await loadExistingPosition(latestTrade);
        updatePositionMark(position, toSafeNumber(latestTrade.price));
        if (!position.isNew || position.size > 0) {
            await position.save();
        }

        const trail = mergePolicyTrail(batch.policyTrail, [
            buildPolicyTrailEntry(
                'source-trade-merge',
                'SKIP',
                `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已取消模拟买入批次`
            ),
        ]);
        const result = createSkippedTraceResult(
            portfolio,
            position,
            `检测到 asset=${trade.asset} 的非买入源交易，已取消未执行的买入批次`,
            batch.requestedUsdc,
            batch.requestedSize,
            batch.sourcePrice
        );
        await syncPortfolioAfterExecution(
            portfolio,
            {
                referenceHash: latestTrade.transactionHash,
                timestamp: latestTrade.timestamp,
            },
            result.status
        );
        await recordTraceExecution({
            executionKey: getBatchExecutionKey(batch._id),
            trades,
            condition: batch.condition,
            result,
            portfolio,
            sourceSide: latestTrade.side,
            copyExecutionBatchId: batch._id,
            policyTrail: trail,
        });
        await TraceExecutionBatch.updateOne(
            { _id: batch._id },
            {
                $set: {
                    status: 'SKIPPED',
                    reason: result.reason,
                    claimedAt: 0,
                    completedAt: Date.now(),
                    policyTrail: trail,
                },
            }
        );
    }
};

const createDirectBatch = async (trade: UserActivityInterface) => {
    await TraceExecutionBatch.create({
        sourceWallet: USER_ADDRESS,
        status: 'READY',
        condition: String(trade.side || '').toLowerCase(),
        asset: trade.asset,
        conditionId: trade.conditionId,
        title: trade.title,
        outcome: trade.outcome,
        side: trade.side,
        sourceTradeIds: [trade._id],
        sourceActivityKeys: [trade.activityKey || trade.transactionHash],
        sourceTransactionHashes: [trade.transactionHash],
        sourceTradeCount: 1,
        sourceStartedAt: trade.timestamp,
        sourceEndedAt: trade.timestamp,
        sourcePrice: Math.max(toSafeNumber(trade.price), 0),
        requestedUsdc: 0,
        requestedSize: 0,
        orderIds: [],
        transactionHashes: [],
        policyTrail: [],
        retryCount: 0,
        claimedAt: 0,
        submittedAt: 0,
        confirmedAt: 0,
        completedAt: 0,
        reason: '',
        submissionStatus: 'CONFIRMED',
    });
};

const processConditionTriggerTrade = async (trade: UserActivityInterface) => {
    const portfolio = await ensurePortfolio();
    const activePositions = (await TracePosition.find({
        conditionId: trade.conditionId,
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    const metadata = await resolveConditionMetadata(trade.conditionId, activePositions, [trade]);
    const settlementOutcome = await settleTraceCondition({
        portfolio,
        conditionId: trade.conditionId,
        positions: activePositions,
        triggerTrades: [trade],
        metadata,
        forceResolutionRefresh: true,
    });

    if (settlementOutcome.status === 'FILLED') {
        return;
    }

    if (
        trade.type === 'MERGE' &&
        settlementOutcome.resolution !== null &&
        !isResolvedPolymarketMarket(settlementOutcome.resolution)
    ) {
        const mergeOutcome = await executeConditionMergeTrade({
            portfolio,
            trade,
            positions: activePositions,
            metadata,
            resolution: settlementOutcome.resolution,
        });
        if (mergeOutcome.status === 'FILLED') {
            const remainingPositions = (await TracePosition.find({
                conditionId: trade.conditionId,
                size: { $gt: 0 },
            }).exec()) as TracePositionDocument[];
            if (remainingPositions.length > 0) {
                await upsertConditionSettlementTask({
                    conditionId: trade.conditionId,
                    metadata,
                    reason: 'condition 级 merge 完成后仍有未平仓位，等待 resolved 自动结算',
                    resolution: mergeOutcome.resolution,
                    triggerTrades: [trade],
                    nextRetryAt: 0,
                });
            }
            return;
        }

        await recordSkippedConditionTrigger({
            portfolio,
            trade,
            reason: mergeOutcome.reason,
            positionSizeBefore: mergeOutcome.positionSizeBefore || 0,
            metadata,
            resolution: mergeOutcome.resolution,
        });

        const remainingPositions = (await TracePosition.find({
            conditionId: trade.conditionId,
            size: { $gt: 0 },
        }).exec()) as TracePositionDocument[];
        if (remainingPositions.length > 0) {
            await upsertConditionSettlementTask({
                conditionId: trade.conditionId,
                metadata,
                reason: mergeOutcome.reason,
                resolution: mergeOutcome.resolution,
                triggerTrades: [trade],
                nextRetryAt: 0,
            });
        }

        logger.info(
            `condition=${trade.conditionId} type=${trade.type} 已跳过 condition 级 merge ` +
                `reason=${mergeOutcome.reason}`
        );
        return;
    }

    await recordSkippedConditionTrigger({
        portfolio,
        trade,
        reason: settlementOutcome.reason,
        positionSizeBefore:
            settlementOutcome.positionSizeBefore ||
            activePositions.reduce((sum, position) => sum + toSafeNumber(position.size), 0),
        metadata,
        resolution: settlementOutcome.resolution,
    });

    const remainingPositions = (await TracePosition.find({
        conditionId: trade.conditionId,
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    if (remainingPositions.length > 0) {
        await upsertConditionSettlementTask({
            conditionId: trade.conditionId,
            metadata,
            reason: settlementOutcome.reason,
            resolution: settlementOutcome.resolution,
            triggerTrades: [trade],
            nextRetryAt: 0,
        });
    }

    logger.info(
        `condition=${trade.conditionId} type=${trade.type} 已跳过 condition 级结算 ` +
            `reason=${settlementOutcome.reason}`
    );
};

const processPendingTrades = async (trades: UserActivityInterface[]) => {
    const resolvedConditionsHandled = new Set<string>();
    let resolvedConditionPortfolio: TracePortfolioDocument | null = null;

    for (const trade of trades) {
        if (trade.type === 'MERGE' || trade.type === 'REDEEM') {
            await processConditionTriggerTrade(trade);
            continue;
        }

        const metadata = await resolveConditionMetadata(trade.conditionId, [], [trade]);
        const resolution = await loadConditionResolution(metadata);
        if (isResolvedPolymarketMarket(resolution)) {
            resolvedConditionPortfolio = resolvedConditionPortfolio || (await ensurePortfolio());
            const reason =
                `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，` +
                '已跳过盘口模拟并转入 condition 级结算';

            if (!resolvedConditionsHandled.has(trade.conditionId)) {
                await cancelResolvedConditionOpenWork({
                    portfolio: resolvedConditionPortfolio,
                    conditionId: trade.conditionId,
                    reason,
                });
                resolvedConditionsHandled.add(trade.conditionId);
            }

            await recordTraceExecution({
                executionKey: `resolved-trade:${trade.activityKey || trade.transactionHash || String(trade._id)}`,
                trades: [trade],
                condition: 'reconcile',
                result: createSkippedTraceResult(
                    resolvedConditionPortfolio,
                    await loadExistingPosition(trade),
                    reason,
                    Math.max(toSafeNumber(trade.usdcSize), 0),
                    Math.max(toSafeNumber(trade.size), 0),
                    Math.max(toSafeNumber(trade.price), 0)
                ),
                portfolio: resolvedConditionPortfolio,
                sourceSide: trade.side || trade.type || 'TRADE',
            });

            logger.info(
                `condition=${trade.conditionId} tx=${trade.transactionHash} 已跳过 resolved 市场盘口模拟`
            );
            continue;
        }

        const validation = validateTradeForTrace(trade);
        if (validation.status === 'RETRY') {
            logger.warn(`${formatTradeRef(trade)} 稍后重试 reason=${validation.reason}`);
            continue;
        }

        if (String(trade.side || '').toUpperCase() === 'BUY') {
            await appendTradeToBuyBuffer(trade);
            logger.info(`${formatTradeRef(trade)} 已加入模拟累计买单缓冲区`);
            continue;
        }

        await cancelOpenBuyBuffersForAsset(trade);
        await cancelReadyBuyBatchesForAsset(trade);
        await createDirectBatch(trade);
        logger.info(`${formatTradeRef(trade)} 已创建模拟执行批次`);
    }
};

const flushReadyBuffers = async () => {
    const buffers = await readFlushableBuffers();
    if (buffers.length === 0) {
        return;
    }

    const portfolio = await ensurePortfolio();
    let virtualAvailableBalance = Math.max(toSafeNumber(portfolio.cashBalance), 0);

    for (const buffer of buffers) {
        const trades = await loadTradesByIds(buffer.sourceTradeIds);
        if (trades.length === 0) {
            await TraceIntentBuffer.updateOne(
                { _id: buffer._id },
                {
                    $set: {
                        state: 'SKIPPED',
                        reason: '累计缓冲缺少关联源交易',
                        claimedAt: 0,
                        completedAt: Date.now(),
                    },
                }
            );
            continue;
        }

        const evaluation = evaluateBuyBuffer({
            trades,
            availableBalance: virtualAvailableBalance,
            expireAt: buffer.expireAt,
            now: Date.now(),
        });
        const trail = mergePolicyTrail(buffer.policyTrail, evaluation.policyTrail);

        if (evaluation.status === 'BUFFER') {
            await TraceIntentBuffer.updateOne(
                { _id: buffer._id },
                {
                    $set: {
                        state: 'OPEN',
                        claimedAt: 0,
                        reason: evaluation.reason,
                        policyTrail: trail,
                    },
                }
            );
            continue;
        }

        if (evaluation.status === 'SKIP') {
            await finalizeSkippedBuffer(buffer, trades, evaluation.reason, trail);
            logger.info(
                `condition=buy asset=${buffer.asset} trades=${buffer.sourceTradeCount} 已跳过 ` +
                    `reason=${evaluation.reason}`
            );
            continue;
        }

        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        if (!latestTrade) {
            continue;
        }

        await TraceExecutionBatch.create({
            sourceWallet: USER_ADDRESS,
            bufferId: buffer._id,
            status: 'READY',
            condition: 'buy',
            asset: latestTrade.asset,
            conditionId: latestTrade.conditionId,
            title: latestTrade.title,
            outcome: latestTrade.outcome,
            side: latestTrade.side,
            sourceTradeIds: trades.map((trade) => trade._id),
            sourceActivityKeys: trades.map((trade) => trade.activityKey || trade.transactionHash),
            sourceTransactionHashes: trades.map((trade) => trade.transactionHash),
            sourceTradeCount: trades.length,
            sourceStartedAt: trades[0].timestamp,
            sourceEndedAt: latestTrade.timestamp,
            sourcePrice: Math.max(evaluation.sourcePrice, toSafeNumber(latestTrade.price), 0),
            requestedUsdc: evaluation.requestedUsdc,
            requestedSize: 0,
            orderIds: [],
            transactionHashes: [],
            policyTrail: trail,
            retryCount: 0,
            claimedAt: 0,
            submittedAt: 0,
            confirmedAt: 0,
            completedAt: 0,
            reason: evaluation.reason,
            submissionStatus: 'CONFIRMED',
        });
        await TraceIntentBuffer.updateOne(
            { _id: buffer._id },
            {
                $set: {
                    state: 'CLOSED',
                    claimedAt: 0,
                    reason: evaluation.reason,
                    policyTrail: trail,
                    completedAt: Date.now(),
                },
            }
        );
        virtualAvailableBalance = Math.max(
            virtualAvailableBalance - Math.max(evaluation.requestedUsdc, 0),
            0
        );
        logger.info(
            `condition=buy asset=${buffer.asset} trades=${buffer.sourceTradeCount} 已创建模拟批次 ` +
                `requestedUsdc=${formatAmount(evaluation.requestedUsdc)}`
        );
    }
};

const executeReadyBatches = async (marketStream: ClobMarketStream) => {
    const readyBatches = await readReadyBatches();
    if (readyBatches.length === 0) {
        return;
    }

    const portfolio = await ensurePortfolio();

    for (const batch of readyBatches) {
        await TraceExecutionBatch.updateOne(
            { _id: batch._id },
            {
                $set: {
                    status: 'PROCESSING',
                    claimedAt: Date.now(),
                },
            }
        );

        try {
            const trades = await loadTradesByIds(batch.sourceTradeIds);
            const orderedTrades = sortTradesAsc(trades);
            const latestTrade = orderedTrades[orderedTrades.length - 1];
            if (!latestTrade) {
                await TraceExecutionBatch.updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            status: 'FAILED',
                            reason: '执行批次缺少关联源交易',
                            claimedAt: 0,
                            completedAt: Date.now(),
                        },
                    }
                );
                continue;
            }

            const existingPosition = await loadExistingPosition(latestTrade);
            const sourcePositionAfterTrade = {
                size: latestTrade.sourcePositionSizeAfterTrade,
            };
            const condition = resolveTradeCondition(
                latestTrade.side,
                existingPosition,
                sourcePositionAfterTrade
            );

            let resultWithPosition;
            if (condition === 'buy' || condition === 'sell' || condition === 'merge') {
                resultWithPosition = await simulateTradeAgainstMarket({
                    portfolio,
                    position: existingPosition,
                    trade: latestTrade,
                    userPosition: sourcePositionAfterTrade,
                    condition,
                    marketStream,
                    executionTarget:
                        batch.requestedUsdc > 0 || batch.requestedSize > 0
                            ? {
                                  requestedUsdc:
                                      batch.requestedUsdc > 0 ? batch.requestedUsdc : undefined,
                                  requestedSize:
                                      batch.requestedSize > 0 ? batch.requestedSize : undefined,
                                  sourcePrice:
                                      batch.sourcePrice > 0 ? batch.sourcePrice : undefined,
                                  note: batch.reason,
                              }
                            : undefined,
                });
            } else {
                updatePositionMark(existingPosition, toSafeNumber(latestTrade.price));
                if (!existingPosition.isNew || existingPosition.size > 0) {
                    await existingPosition.save();
                }

                resultWithPosition = {
                    result: createSkippedTraceResult(
                        portfolio,
                        existingPosition,
                        `暂不支持的执行条件: ${condition}`,
                        batch.requestedUsdc,
                        batch.requestedSize,
                        Math.max(batch.sourcePrice, toSafeNumber(latestTrade.price))
                    ),
                    position: existingPosition,
                };
            }

            const userPositionsRaw = await fetchSourcePositions();
            if (userPositionsRaw) {
                await refreshOpenPositionMarks(userPositionsRaw);
            }

            await syncPortfolioAfterExecution(
                portfolio,
                {
                    referenceHash: latestTrade.transactionHash,
                    timestamp: latestTrade.timestamp,
                },
                resultWithPosition.result.status
            );
            await recordTraceExecution({
                executionKey: getBatchExecutionKey(batch._id),
                trades,
                condition,
                result: resultWithPosition.result,
                portfolio,
                sourceSide: latestTrade.side,
                copyIntentBufferId: batch.bufferId,
                copyExecutionBatchId: batch._id,
                policyTrail: batch.policyTrail,
            });

            await TraceExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: {
                        status:
                            resultWithPosition.result.status === 'FILLED' ? 'CONFIRMED' : 'SKIPPED',
                        reason: resultWithPosition.result.reason,
                        claimedAt: 0,
                        confirmedAt: Date.now(),
                        completedAt: Date.now(),
                        submissionStatus: 'CONFIRMED',
                    },
                }
            );

            logger.info(
                `${formatBatchRef(batch)} status=${resultWithPosition.result.status} ` +
                    `cash=${formatAmount(portfolio.cashBalance)} ` +
                    `equity=${formatAmount(portfolio.totalEquity)}` +
                    (resultWithPosition.result.reason
                        ? ` reason=${resultWithPosition.result.reason}`
                        : '')
            );
        } catch (error) {
            if (error instanceof RetryableTraceError) {
                await TraceExecutionBatch.updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            status: 'READY',
                            claimedAt: 0,
                            reason: error.message,
                        },
                    }
                );
                logger.warn(`${formatBatchRef(batch)} 稍后重试 reason=${error.message}`);
                continue;
            }

            logger.error(`${formatBatchRef(batch)} 执行异常`, error);
            await TraceExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: {
                        status: 'FAILED',
                        claimedAt: 0,
                        reason: '模拟执行链路发生未预期异常',
                        completedAt: Date.now(),
                    },
                }
            );
        }
    }
};

const paperTradeExecutor = async (marketStream: ClobMarketStream) => {
    logger.info('启动模拟跟单');
    const processingCount = await TraceExecutionBatch.countDocuments({ status: 'PROCESSING' });
    let lastTracePortfolioSyncAt = 0;
    let lastSettlementTaskSyncAt = 0;
    if (processingCount > 0) {
        logger.warn(`检测到 ${processingCount} 个 PROCESSING 批次，本次启动会自动回收续跑`);
    }

    while (true) {
        const pendingTrades = await loadPendingTrades();
        if (pendingTrades.length > 0) {
            spinner.stop();
            logger.info(`发现 ${pendingTrades.length} 条待处理模拟交易`);
            await processPendingTrades(pendingTrades);
        }

        if (Date.now() - lastSettlementTaskSyncAt >= TRACE_SETTLEMENT_TASK_SYNC_INTERVAL_MS) {
            await syncConditionSettlementTasksFromOpenPositions();
            lastSettlementTaskSyncAt = Date.now();
        }
        await processReadyConditionSettlementTasks();
        await sweepResolvedConditionOpenWork();

        await flushReadyBuffers();
        await executeReadyBatches(marketStream);

        const openWorkCount =
            (await TraceIntentBuffer.countDocuments({
                state: { $in: ['OPEN', 'FLUSHING'] },
            })) +
            (await TraceExecutionBatch.countDocuments({
                status: { $in: ['READY', 'PROCESSING'] },
            }));

        if (pendingTrades.length === 0 && openWorkCount === 0) {
            if (Date.now() - lastTracePortfolioSyncAt >= TRACE_PORTFOLIO_SYNC_INTERVAL_MS) {
                const portfolio = await ensurePortfolio();
                await syncTracePortfolioWithPolymarket(portfolio);
                lastTracePortfolioSyncAt = Date.now();
            }
            await spinner.start('等待新的模拟交易');
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
};

export default paperTradeExecutor;
