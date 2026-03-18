import { HydratedDocument } from 'mongoose';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { TracePortfolioInterface, TracePositionInterface } from '../interfaces/Trace';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import {
    getTraceExecutionModel,
    getTracePortfolioModel,
    getTracePositionModel,
} from '../models/traceHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import resolveTradeCondition from '../utils/resolveTradeCondition';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TRACE_ID = ENV.TRACE_ID;
const TRACE_LABEL = ENV.TRACE_LABEL;
const TRACE_INITIAL_BALANCE = ENV.TRACE_INITIAL_BALANCE;

const SourceActivity = getUserActivityModel(USER_ADDRESS);
const TraceExecution = getTraceExecutionModel(USER_ADDRESS, TRACE_ID);
const TracePortfolio = getTracePortfolioModel(USER_ADDRESS, TRACE_ID);
const TracePosition = getTracePositionModel(USER_ADDRESS, TRACE_ID);

const EPSILON = 1e-8;

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

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeSize = (value: number) => (Math.abs(value) < EPSILON ? 0 : value);

const updatePositionMark = (position: TracePositionDocument, marketPrice: number) => {
    if (!position || marketPrice <= 0) {
        return;
    }

    position.marketPrice = marketPrice;
    position.marketValue = position.size * marketPrice;
    position.unrealizedPnl = position.marketValue - position.costBasis;
    position.avgPrice = position.size > 0 ? position.costBasis / position.size : 0;
};

const findUserPosition = (
    positions: UserPositionInterface[],
    trade: UserActivityInterface
): UserPositionInterface | undefined =>
    positions.find((position) => position.asset === trade.asset) ||
    positions.find(
        (position) =>
            position.conditionId === trade.conditionId &&
            position.outcomeIndex === trade.outcomeIndex
    ) ||
    positions.find((position) => position.conditionId === trade.conditionId);

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

const loadPendingTrades = async () => {
    const trades = (await SourceActivity.find({
        type: 'TRADE',
        transactionHash: { $exists: true, $ne: '' },
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];

    const executedDocs = (await TraceExecution.find(
        {},
        { sourceTransactionHash: 1 }
    ).exec()) as Array<{
        sourceTransactionHash?: string;
    }>;
    const executedHashes = new Set(
        executedDocs
            .map((doc) => doc.sourceTransactionHash)
            .filter((hash): hash is string => Boolean(hash))
    );

    return trades.filter((trade) => !executedHashes.has(trade.transactionHash));
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

const refreshOpenPositionMarks = async (userPositions: UserPositionInterface[]) => {
    const activePositions = (await TracePosition.find({
        size: { $gt: 0 },
    }).exec()) as TracePositionDocument[];

    for (const tracePosition of activePositions) {
        const matchedUserPosition = userPositions.find(
            (userPosition) => userPosition.asset === tracePosition.asset
        );
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

const simulateBuy = async (
    portfolio: TracePortfolioDocument,
    position: TracePositionDocument,
    trade: UserActivityInterface
) => {
    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const requestedUsdc = Math.max(toSafeNumber(trade.usdcSize), 0);
    const price = toSafeNumber(trade.price);
    const positionSizeBefore = toSafeNumber(position.size);

    if (cashBefore <= 0) {
        return {
            result: {
                status: 'SKIPPED',
                reason: '模拟资金不足',
                requestedSize: Math.max(toSafeNumber(trade.size), 0),
                executedSize: 0,
                requestedUsdc,
                executedUsdc: 0,
                executionPrice: price,
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

    if (requestedUsdc <= 0 || price <= 0) {
        return {
            result: {
                status: 'SKIPPED',
                reason: '买入价格或金额无效',
                requestedSize: Math.max(toSafeNumber(trade.size), 0),
                executedSize: 0,
                requestedUsdc,
                executedUsdc: 0,
                executionPrice: price,
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

    const executedUsdc = Math.min(requestedUsdc, cashBefore);
    const executedSize = executedUsdc / price;

    portfolio.cashBalance = cashBefore - executedUsdc;

    position.conditionId = trade.conditionId;
    position.title = trade.title;
    position.outcome = trade.outcome;
    position.side = trade.side;
    position.size = normalizeSize(toSafeNumber(position.size) + executedSize);
    position.costBasis = toSafeNumber(position.costBasis) + executedUsdc;
    position.totalBoughtSize = toSafeNumber(position.totalBoughtSize) + executedSize;
    position.totalBoughtUsdc = toSafeNumber(position.totalBoughtUsdc) + executedUsdc;
    position.lastSourceTransactionHash = trade.transactionHash;
    position.lastTradedAt = trade.timestamp;
    position.closedAt = undefined;

    updatePositionMark(position, price);
    await position.save();

    return {
        result: {
            status: 'FILLED',
            reason: executedUsdc < requestedUsdc ? '余额不足，已按可用资金部分成交' : '',
            requestedSize: Math.max(toSafeNumber(trade.size), 0),
            executedSize,
            requestedUsdc,
            executedUsdc,
            executionPrice: price,
            cashBefore,
            cashAfter: toSafeNumber(portfolio.cashBalance),
            positionSizeBefore,
            positionSizeAfter: toSafeNumber(position.size),
            realizedPnlDelta: 0,
            unrealizedPnlAfter: toSafeNumber(position.unrealizedPnl),
        } satisfies ExecutionResult,
        position,
    };
};

const simulateSellLike = async (
    portfolio: TracePortfolioDocument,
    position: TracePositionDocument,
    trade: UserActivityInterface,
    userPosition: UserPositionInterface | undefined,
    condition: string
) => {
    const cashBefore = toSafeNumber(portfolio.cashBalance);
    const positionSizeBefore = toSafeNumber(position.size);
    const fallbackPrice = toSafeNumber(position.marketPrice) || toSafeNumber(position.avgPrice);
    const price = toSafeNumber(trade.price, fallbackPrice);

    if (positionSizeBefore <= 0) {
        return {
            result: {
                status: 'SKIPPED',
                reason: '本地模拟仓位为空，无法卖出',
                requestedSize: Math.max(toSafeNumber(trade.size), 0),
                executedSize: 0,
                requestedUsdc: Math.max(toSafeNumber(trade.usdcSize), 0),
                executedUsdc: 0,
                executionPrice: price,
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

    if (price <= 0) {
        return {
            result: {
                status: 'SKIPPED',
                reason: '缺少可用价格，无法计算卖出结果',
                requestedSize: Math.max(toSafeNumber(trade.size), 0),
                executedSize: 0,
                requestedUsdc: Math.max(toSafeNumber(trade.usdcSize), 0),
                executedUsdc: 0,
                executionPrice: price,
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

    let requestedSize = positionSizeBefore;
    if (condition === 'sell' && userPosition) {
        const denominator = toSafeNumber(userPosition.size) + Math.max(toSafeNumber(trade.size), 0);
        requestedSize =
            denominator > 0 ? positionSizeBefore * (toSafeNumber(trade.size) / denominator) : 0;
    }

    requestedSize = Math.min(positionSizeBefore, Math.max(requestedSize, 0));

    if (requestedSize <= 0) {
        updatePositionMark(position, price);
        await position.save();

        return {
            result: {
                status: 'SKIPPED',
                reason: '没有可卖出的模拟数量',
                requestedSize,
                executedSize: 0,
                requestedUsdc: requestedSize * price,
                executedUsdc: 0,
                executionPrice: price,
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

    const costBasisReleased =
        positionSizeBefore > 0
            ? toSafeNumber(position.costBasis) * (requestedSize / positionSizeBefore)
            : 0;
    const executedUsdc = requestedSize * price;
    const realizedPnlDelta = executedUsdc - costBasisReleased;

    portfolio.cashBalance = cashBefore + executedUsdc;
    portfolio.realizedPnl = toSafeNumber(portfolio.realizedPnl) + realizedPnlDelta;

    position.conditionId = trade.conditionId;
    position.title = trade.title;
    position.outcome = trade.outcome;
    position.side = trade.side;
    position.size = normalizeSize(positionSizeBefore - requestedSize);
    position.costBasis = normalizeSize(toSafeNumber(position.costBasis) - costBasisReleased);
    position.realizedPnl = toSafeNumber(position.realizedPnl) + realizedPnlDelta;
    position.totalSoldSize = toSafeNumber(position.totalSoldSize) + requestedSize;
    position.totalSoldUsdc = toSafeNumber(position.totalSoldUsdc) + executedUsdc;
    position.lastSourceTransactionHash = trade.transactionHash;
    position.lastTradedAt = trade.timestamp;

    if (position.size === 0) {
        position.costBasis = 0;
        position.avgPrice = 0;
        position.closedAt = trade.timestamp;
    }

    updatePositionMark(position, price);
    await position.save();

    return {
        result: {
            status: 'FILLED',
            reason: '',
            requestedSize,
            executedSize: requestedSize,
            requestedUsdc: requestedSize * price,
            executedUsdc,
            executionPrice: price,
            cashBefore,
            cashAfter: toSafeNumber(portfolio.cashBalance),
            positionSizeBefore,
            positionSizeAfter: toSafeNumber(position.size),
            realizedPnlDelta,
            unrealizedPnlAfter: toSafeNumber(position.unrealizedPnl),
        } satisfies ExecutionResult,
        position,
    };
};

const syncPortfolio = async (
    portfolio: TracePortfolioDocument,
    trade: UserActivityInterface,
    status: ExecutionStatus
) => {
    const metrics = await collectPortfolioMetrics(portfolio);

    portfolio.positionsMarketValue = metrics.positionsMarketValue;
    portfolio.unrealizedPnl = metrics.unrealizedPnl;
    portfolio.totalEquity = metrics.totalEquity;
    portfolio.netPnl = metrics.netPnl;
    portfolio.returnPct = metrics.returnPct;
    portfolio.totalExecutions = toSafeNumber(portfolio.totalExecutions) + 1;
    portfolio.filledExecutions =
        toSafeNumber(portfolio.filledExecutions) + (status === 'FILLED' ? 1 : 0);
    portfolio.skippedExecutions =
        toSafeNumber(portfolio.skippedExecutions) + (status === 'SKIPPED' ? 1 : 0);
    portfolio.lastSourceTransactionHash = trade.transactionHash;
    portfolio.lastUpdatedAt = trade.timestamp;

    await portfolio.save();

    return metrics;
};

const recordExecution = async (
    trade: UserActivityInterface,
    condition: string,
    portfolio: TracePortfolioDocument,
    result: ExecutionResult
) => {
    await TraceExecution.create({
        traceId: TRACE_ID,
        traceLabel: TRACE_LABEL,
        sourceWallet: USER_ADDRESS,
        sourceActivityId: trade._id,
        sourceTransactionHash: trade.transactionHash,
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
    });
};

const processTrade = async (trade: UserActivityInterface) => {
    const portfolio = await ensurePortfolio();
    const existingPosition =
        ((await TracePosition.findOne({
            asset: trade.asset,
        }).exec()) as TracePositionDocument | null) || createEmptyPosition(trade);

    const userPositionsRaw = await fetchData(
        `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
    );
    const userPositions: UserPositionInterface[] = Array.isArray(userPositionsRaw)
        ? userPositionsRaw
        : [];
    const userPosition = findUserPosition(userPositions, trade);
    const condition = resolveTradeCondition(trade.side, existingPosition, userPosition);

    let resultWithPosition;
    if (condition === 'buy') {
        resultWithPosition = await simulateBuy(portfolio, existingPosition, trade);
    } else if (condition === 'sell' || condition === 'merge') {
        resultWithPosition = await simulateSellLike(
            portfolio,
            existingPosition,
            trade,
            userPosition,
            condition
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

    await refreshOpenPositionMarks(userPositions);
    await syncPortfolio(portfolio, trade, resultWithPosition.result.status);
    await recordExecution(trade, condition, portfolio, resultWithPosition.result);

    console.log(
        `[trace:${TRACE_ID}] ${trade.transactionHash} ${resultWithPosition.result.status} ` +
            `cash=${portfolio.cashBalance.toFixed(4)} equity=${portfolio.totalEquity.toFixed(4)}`
    );
};

const traceExecutor = async () => {
    console.log(`Executing Trace Trading (${TRACE_LABEL})`);

    while (true) {
        const pendingTrades = await loadPendingTrades();
        if (pendingTrades.length > 0) {
            console.log(`🧪 ${pendingTrades.length} new trace transaction(s) found 🧪`);
            spinner.stop();

            for (const trade of pendingTrades) {
                try {
                    await processTrade(trade);
                } catch (error) {
                    console.error(
                        `[trace:${TRACE_ID}] Error processing trade ${trade.transactionHash}:`,
                        error
                    );
                }
            }
        } else {
            await spinner.start(`Waiting for new trace transactions (${TRACE_LABEL})`);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default traceExecutor;
