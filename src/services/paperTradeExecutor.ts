import { Side } from '@polymarket/clob-client';
import { HydratedDocument } from 'mongoose';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { TracePortfolioInterface, TracePositionInterface } from '../interfaces/Trace';
import { ENV } from '../config/env';
import ClobMarketStream from './clobMarketStream';
import { getUserActivityModel } from '../models/userHistory';
import {
    getTraceExecutionModel,
    getTracePortfolioModel,
    getTracePositionModel,
} from '../models/traceHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import {
    buildChunkExecutionPlan,
    cloneMarketSnapshot,
    consumeMarketLiquidity,
} from '../utils/executionPlanning';
import createLogger from '../utils/logger';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TRACE_ID = ENV.TRACE_ID;
const TRACE_LABEL = ENV.TRACE_LABEL;
const TRACE_INITIAL_BALANCE = ENV.TRACE_INITIAL_BALANCE;
const logger = createLogger(TRACE_LABEL);

const SourceActivity = getUserActivityModel(USER_ADDRESS);
const TraceExecution = getTraceExecutionModel(USER_ADDRESS, TRACE_ID);
const TracePortfolio = getTracePortfolioModel(USER_ADDRESS, TRACE_ID);
const TracePosition = getTracePositionModel(USER_ADDRESS, TRACE_ID);

const EPSILON = 1e-8;
const SETTLEMENT_PRICE = 1;
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

class RetryableTraceError extends Error {}

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSize = (value: number) => (Math.abs(value) < EPSILON ? 0 : value);
const formatAmount = (value: unknown) => toSafeNumber(value).toFixed(4);
const formatTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset' | 'side'>) =>
    `tx=${trade.transactionHash} side=${String(trade.side || '').toUpperCase()} asset=${trade.asset}`;
const getSourceExecutionKey = (
    trade: Pick<UserActivityInterface, 'activityKey' | 'transactionHash'>
) => String(trade.activityKey || trade.transactionHash || '').trim();

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

const loadPendingTrades = async () => {
    const trades = (await SourceActivity.find({
        $and: [
            { type: 'TRADE' },
            { $or: [{ executionIntent: 'EXECUTE' }, { executionIntent: { $exists: false } }] },
            { $or: [{ snapshotStatus: 'COMPLETE' }, { snapshotStatus: { $exists: false } }] },
            { transactionHash: { $exists: true, $ne: '' } },
        ],
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];

    const executedDocs = (await TraceExecution.find(
        {},
        { sourceActivityKey: 1, sourceTransactionHash: 1 }
    ).exec()) as Array<{
        sourceActivityKey?: string;
        sourceTransactionHash?: string;
    }>;
    const executedHashes = new Set(
        executedDocs
            .map((doc) => String(doc.sourceActivityKey || doc.sourceTransactionHash || '').trim())
            .filter(Boolean)
    );

    return trades.filter((trade) => !executedHashes.has(getSourceExecutionKey(trade)));
};

const claimTradeExecution = async (trade: UserActivityInterface) => {
    const sourceExecutionKey = getSourceExecutionKey(trade);
    const result = await TraceExecution.updateOne(
        {
            sourceActivityKey: sourceExecutionKey,
        },
        {
            $setOnInsert: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: trade._id,
                sourceActivityKey: sourceExecutionKey,
                sourceTransactionHash: trade.transactionHash,
                sourceTimestamp: trade.timestamp,
                sourceSide: trade.side,
                executionCondition: '',
                status: 'PROCESSING',
                reason: '',
                asset: trade.asset,
                conditionId: trade.conditionId,
                title: trade.title,
                outcome: trade.outcome,
                claimedAt: Date.now(),
                completedAt: 0,
            },
        },
        {
            upsert: true,
        }
    );

    return result.upsertedCount === 1;
};

const releaseTradeClaim = async (trade: UserActivityInterface) => {
    await TraceExecution.deleteOne({
        sourceActivityKey: getSourceExecutionKey(trade),
        status: 'PROCESSING',
    });
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

const simulateTradeAgainstMarket = async (
    portfolio: TracePortfolioDocument,
    position: TracePositionDocument,
    trade: UserActivityInterface,
    userPosition: { size?: number } | undefined,
    condition: string,
    marketStream: ClobMarketStream
) => {
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
    let lastExecutionPrice = toSafeNumber(trade.price);
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
                        reason: plan.reason,
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

            finalReason = [finalReason, plan.reason].filter(Boolean).join('；');
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
                    ? Math.max(toSafeNumber(trade.size), 0)
                    : totalExecutedSize + Math.max(remainingRequestedSize || 0, 0),
            executedSize: totalExecutedSize,
            requestedUsdc:
                condition === 'buy'
                    ? totalExecutedUsdc + Math.max(remainingRequestedUsdc || 0, 0)
                    : (totalExecutedSize + Math.max(remainingRequestedSize || 0, 0)) *
                      Math.max(lastExecutionPrice, 0),
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
                    sourceTimestamp: settledAt,
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

const recordExecution = async (
    trade: UserActivityInterface,
    condition: string,
    portfolio: TracePortfolioDocument,
    result: ExecutionResult
) => {
    await TraceExecution.updateOne(
        {
            sourceActivityKey: getSourceExecutionKey(trade),
        },
        {
            $set: {
                traceId: TRACE_ID,
                traceLabel: TRACE_LABEL,
                sourceWallet: USER_ADDRESS,
                sourceActivityId: trade._id,
                sourceActivityKey: getSourceExecutionKey(trade),
                sourceTimestamp: trade.timestamp,
                sourceSide: trade.side,
                executionCondition: condition,
                status: result.status,
                reason: result.reason,
                asset: trade.asset,
                conditionId: trade.conditionId,
                title: trade.title,
                outcome: trade.outcome,
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
                completedAt: Date.now(),
            },
        }
    );
};

const processTrade = async (trade: UserActivityInterface, marketStream: ClobMarketStream) => {
    if (trade.snapshotStatus && trade.snapshotStatus !== 'COMPLETE') {
        throw new RetryableTraceError(trade.sourceSnapshotReason || '源账户快照尚未完整');
    }

    if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
        throw new RetryableTraceError('缺少源账户持仓快照');
    }

    const portfolio = await ensurePortfolio();
    const existingPosition =
        ((await TracePosition.findOne({
            asset: trade.asset,
        }).exec()) as TracePositionDocument | null) || createEmptyPosition(trade);
    const sourcePositionAfterTrade = {
        size: trade.sourcePositionSizeAfterTrade,
    };
    const condition = resolveTradeCondition(trade.side, existingPosition, sourcePositionAfterTrade);

    let resultWithPosition;
    if (condition === 'buy' || condition === 'sell' || condition === 'merge') {
        resultWithPosition = await simulateTradeAgainstMarket(
            portfolio,
            existingPosition,
            trade,
            sourcePositionAfterTrade,
            condition,
            marketStream
        );
    } else {
        updatePositionMark(existingPosition, toSafeNumber(trade.price));
        if (!existingPosition.isNew || existingPosition.size > 0) {
            await existingPosition.save();
        }

        resultWithPosition = {
            result: {
                status: 'SKIPPED',
                reason: `暂不支持的执行条件: ${condition}`,
                requestedSize: Math.max(toSafeNumber(trade.size), 0),
                executedSize: 0,
                requestedUsdc: Math.max(toSafeNumber(trade.usdcSize), 0),
                executedUsdc: 0,
                executionPrice: toSafeNumber(trade.price),
                cashBefore: toSafeNumber(portfolio.cashBalance),
                cashAfter: toSafeNumber(portfolio.cashBalance),
                positionSizeBefore: toSafeNumber(existingPosition.size),
                positionSizeAfter: toSafeNumber(existingPosition.size),
                realizedPnlDelta: 0,
                unrealizedPnlAfter: toSafeNumber(existingPosition.unrealizedPnl),
            } satisfies ExecutionResult,
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
            referenceHash: trade.transactionHash,
            timestamp: trade.timestamp,
        },
        resultWithPosition.result.status
    );
    await recordExecution(trade, condition, portfolio, resultWithPosition.result);

    logger.info(
        `${formatTradeRef(trade)} status=${resultWithPosition.result.status} ` +
            `cash=${formatAmount(portfolio.cashBalance)} ` +
            `equity=${formatAmount(portfolio.totalEquity)}` +
            (resultWithPosition.result.reason ? ` reason=${resultWithPosition.result.reason}` : '')
    );
};

const paperTradeExecutor = async (marketStream: ClobMarketStream) => {
    logger.info('启动模拟跟单');
    const processingCount = await TraceExecution.countDocuments({ status: 'PROCESSING' });
    if (processingCount > 0) {
        logger.warn(
            `检测到 ${processingCount} 条 PROCESSING 记录，为避免重复记账，本次不会自动重放`
        );
    }

    while (true) {
        const pendingTrades = await loadPendingTrades();
        if (pendingTrades.length > 0) {
            spinner.stop();
            logger.info(`发现 ${pendingTrades.length} 条待处理模拟交易`);

            for (const trade of pendingTrades) {
                const claimed = await claimTradeExecution(trade);
                if (!claimed) {
                    continue;
                }

                try {
                    await processTrade(trade, marketStream);
                } catch (error) {
                    if (error instanceof RetryableTraceError) {
                        await releaseTradeClaim(trade);
                        logger.warn(`${formatTradeRef(trade)} 稍后重试 reason=${error.message}`);
                        continue;
                    }

                    logger.error(`${formatTradeRef(trade)} 执行异常`, error);
                }
            }
        } else {
            const portfolio = await ensurePortfolio();
            await syncTracePortfolioWithPolymarket(portfolio);
            await spinner.start('等待新的模拟交易');
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default paperTradeExecutor;
