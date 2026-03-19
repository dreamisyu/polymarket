import { Side } from '@polymarket/clob-client';
import { HydratedDocument } from 'mongoose';
import {
    CopyExecutionBatchInterface,
    CopyIntentBufferInterface,
    ExecutionPolicyTrailEntry,
} from '../interfaces/Execution';
import { TracePortfolioInterface, TracePositionInterface } from '../interfaces/Trace';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getCopyExecutionBatchModel, getCopyIntentBufferModel } from '../models/copyExecution';
import { getTraceExecutionModel, getTracePortfolioModel, getTracePositionModel } from '../models/traceHistory';
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
import fetchData from '../utils/fetchData';
import createLogger from '../utils/logger';
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

const EPSILON = 1e-8;
const SETTLEMENT_PRICE = 1;
const PROCESSING_LEASE_MS = ENV.PROCESSING_LEASE_MS;
const SOURCE_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}&sizeThreshold=0`;

type ExecutionStatus = 'FILLED' | 'SKIPPED';
type TracePortfolioDocument = HydratedDocument<TracePortfolioInterface>;
type TracePositionDocument = HydratedDocument<TracePositionInterface>;

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
const buildClaimableFilter = (fieldName: string, leaseCutoff: number) => ({
    $or: [
        { [fieldName]: { $exists: false } },
        { [fieldName]: 0 },
        { [fieldName]: { $lt: leaseCutoff } },
    ],
});
const getBatchExecutionKey = (batchId: CopyExecutionBatchInterface['_id']) => `batch:${String(batchId)}`;

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
        title: trade.title,
        outcome: trade.outcome,
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
    tracePosition: Pick<TracePositionInterface, 'asset' | 'conditionId' | 'outcome'>
) =>
    userPositions.find((userPosition) => userPosition.asset === tracePosition.asset) ||
    userPositions.find(
        (userPosition) =>
            userPosition.conditionId === tracePosition.conditionId &&
            userPosition.outcome === tracePosition.outcome
    ) ||
    userPositions.find((userPosition) => userPosition.conditionId === tracePosition.conditionId);

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
    position.title = trade.title;
    position.outcome = trade.outcome;
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
                          (executionTarget?.requestedUsdc || 0) / Math.max(lastExecutionPrice, EPSILON)
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
                    : totalExecutedUsdc + Math.max(remainingRequestedSize || 0, 0) * Math.max(lastExecutionPrice, 0),
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

const autoSettleRedeemablePositions = async (
    portfolio: TracePortfolioDocument,
    userPositions: UserPositionInterface[]
) => {
    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];
    let settledCount = 0;

    for (const tracePosition of activePositions) {
        const matchedUserPosition = matchUserPosition(userPositions, tracePosition);
        if (!matchedUserPosition?.redeemable) {
            continue;
        }

        const positionSizeBefore = toSafeNumber(tracePosition.size);
        if (positionSizeBefore <= 0) {
            continue;
        }

        const settledAt = Date.now();
        const settlementExecutionId = `settlement:${tracePosition.asset}`;
        const cashBefore = toSafeNumber(portfolio.cashBalance);
        const executedUsdc = positionSizeBefore * SETTLEMENT_PRICE;
        const realizedPnlDelta = executedUsdc - toSafeNumber(tracePosition.costBasis);

        portfolio.cashBalance = cashBefore + executedUsdc;
        portfolio.realizedPnl = toSafeNumber(portfolio.realizedPnl) + realizedPnlDelta;

        tracePosition.marketPrice = SETTLEMENT_PRICE;
        tracePosition.size = 0;
        tracePosition.costBasis = 0;
        tracePosition.marketValue = 0;
        tracePosition.avgPrice = 0;
        tracePosition.unrealizedPnl = 0;
        tracePosition.realizedPnl = toSafeNumber(tracePosition.realizedPnl) + realizedPnlDelta;
        tracePosition.lastSourceTransactionHash = settlementExecutionId;
        tracePosition.lastTradedAt = settledAt;
        tracePosition.closedAt = settledAt;
        await tracePosition.save();

        await syncPortfolioAfterExecution(
            portfolio,
            {
                referenceHash: settlementExecutionId,
                timestamp: settledAt,
            },
            'FILLED'
        );

        await TraceExecution.updateOne(
            {
                sourceActivityKey: settlementExecutionId,
            },
            {
                $set: {
                    traceId: TRACE_ID,
                    traceLabel: TRACE_LABEL,
                    sourceWallet: USER_ADDRESS,
                    sourceActivityKey: settlementExecutionId,
                    sourceActivityKeys: [settlementExecutionId],
                    sourceTransactionHash: settlementExecutionId,
                    sourceTransactionHashes: [settlementExecutionId],
                    sourceTradeCount: 1,
                    sourceTimestamp: settledAt,
                    sourceStartedAt: settledAt,
                    sourceEndedAt: settledAt,
                    sourceSide: 'SETTLE',
                    executionCondition: 'settle',
                    status: 'FILLED',
                    reason: '根据 Polymarket redeemable 状态自动结算',
                    asset: tracePosition.asset,
                    conditionId: tracePosition.conditionId,
                    title: tracePosition.title,
                    outcome: tracePosition.outcome,
                    requestedSize: positionSizeBefore,
                    executedSize: positionSizeBefore,
                    requestedUsdc: executedUsdc,
                    executedUsdc,
                    executionPrice: SETTLEMENT_PRICE,
                    cashBefore,
                    cashAfter: toSafeNumber(portfolio.cashBalance),
                    positionSizeBefore,
                    positionSizeAfter: 0,
                    realizedPnlDelta,
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

        settledCount += 1;

        logger.info(
            `自动结算 asset=${tracePosition.asset} ` +
                `size=${formatAmount(positionSizeBefore)} payout=${formatAmount(executedUsdc)}`
        );
    }

    return settledCount;
};

const syncTracePortfolioWithPolymarket = async (portfolio: TracePortfolioDocument) => {
    const userPositions = await fetchSourcePositions();
    if (!userPositions) {
        return;
    }

    await refreshOpenPositionMarks(userPositions);

    const settledCount = await autoSettleRedeemablePositions(portfolio, userPositions);
    if (settledCount > 0) {
        return;
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
                { type: 'TRADE' },
                { $or: [{ executionIntent: 'EXECUTE' }, { executionIntent: { $exists: false } }] },
                { $or: [{ snapshotStatus: 'COMPLETE' }, { snapshotStatus: { $exists: false } }] },
                { transactionHash: { $exists: true, $ne: '' } },
            ],
        })
            .sort({ timestamp: 1 })
            .exec(),
        readTrackedTradeIds(),
    ]);

    return (trades as UserActivityInterface[]).filter((trade) => !trackedIds.has(String(trade._id)));
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
                sourceActivityKeys: orderedTrades.map((trade) => trade.activityKey || trade.transactionHash),
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
                title: lastTrade.title,
                outcome: lastTrade.outcome,
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

    if (String(trade.side || '').toUpperCase() === 'BUY' && !Number.isFinite(trade.sourceBalanceAfterTrade)) {
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

const processPendingTrades = async (trades: UserActivityInterface[]) => {
    for (const trade of trades) {
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
                                  sourcePrice: batch.sourcePrice > 0 ? batch.sourcePrice : undefined,
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
                        status: resultWithPosition.result.status === 'FILLED' ? 'CONFIRMED' : 'SKIPPED',
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
            const portfolio = await ensurePortfolio();
            await syncTracePortfolioWithPolymarket(portfolio);
            await spinner.start('等待新的模拟交易');
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }
};

export default paperTradeExecutor;
