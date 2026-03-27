import { ClobClient } from '@polymarket/clob-client';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type {
    MergeExecutionRequest,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
} from '../../domain/types';
import { buildChunkExecutionPlan, buildMarketBookSnapshot } from '../../utils/executionPlanning';
import { normalizeSize } from '../../utils/math';
import type { LedgerStore, LoggerLike, TradingGateway } from '../runtime/contracts';
import { buildConditionPositionSnapshot, buildPortfolioSnapshot } from './shared';

const epsilon = 1e-8;

const emptyResult = (reason: string, request: { requestedUsdc?: number; requestedSize?: number }, event: SourceTradeEvent) => ({
    status: 'skipped' as const,
    reason,
    requestedUsdc: Math.max(Number(request.requestedUsdc) || Number(event.usdcSize) || 0, 0),
    requestedSize: Math.max(Number(request.requestedSize) || Number(event.size) || 0, 0),
    executedUsdc: 0,
    executedSize: 0,
    executionPrice: 0,
    orderIds: [],
    transactionHashes: [],
});

export class PaperTradingGateway implements TradingGateway {
    private readonly config: RuntimeConfig;
    private readonly logger: LoggerLike;
    private readonly ledgerStore: LedgerStore;
    private readonly clobClient: ClobClient;

    constructor(params: {
        config: RuntimeConfig;
        logger: LoggerLike;
        ledgerStore: LedgerStore;
        clobClient: ClobClient;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.ledgerStore = params.ledgerStore;
        this.clobClient = params.clobClient;
    }

    async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
        await this.ledgerStore.ensurePortfolio(this.config.traceInitialBalance);
        return this.ledgerStore.getPortfolio();
    }

    async getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null> {
        return this.ledgerStore.findPositionByAsset(event.asset);
    }

    async listConditionPositions(conditionId: string) {
        const positions = await this.ledgerStore.listPositions();
        return buildConditionPositionSnapshot(positions, conditionId);
    }

    async executeTrade(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        if (event.action !== 'buy' && event.action !== 'sell') {
            return emptyResult('当前节点仅处理 BUY/SELL', request, event);
        }

        await this.ledgerStore.ensurePortfolio(this.config.traceInitialBalance);
        const [portfolio, localPosition, orderBook] = await Promise.all([
            this.ledgerStore.getPortfolio(),
            this.ledgerStore.findPositionByAsset(event.asset),
            this.clobClient.getOrderBook(event.asset),
        ]);
        const snapshot = buildMarketBookSnapshot(event.asset, orderBook);
        const plan = buildChunkExecutionPlan({
            condition: event.action,
            trade: event,
            myPositionSize: Math.max(Number(localPosition?.size) || 0, 0),
            sourcePositionAfterTradeSize: Math.max(Number(event.sourcePositionSizeAfterTrade) || 0, 0),
            availableBalance: Math.max(Number(portfolio.cashBalance) || 0, 0),
            marketSnapshot: snapshot,
            config: this.config,
            requestedUsdcOverride: request.requestedUsdc,
            requestedSizeOverride: request.requestedSize,
            sourcePriceOverride: event.price,
            noteOverride: request.note,
        });
        if (plan.status === 'SKIPPED') {
            return emptyResult(plan.reason, request, event);
        }
        if (plan.status !== 'READY') {
            return {
                ...emptyResult(plan.reason, request, event),
                status: 'retry',
                reason: plan.reason,
            };
        }

        const executedUsdc = event.action === 'buy' ? plan.orderAmount : plan.orderAmount * plan.executionPrice;
        const executedSize = event.action === 'buy' ? executedUsdc / Math.max(plan.executionPrice, 0.0001) : plan.orderAmount;
        await this.applyTradeExecution(event, localPosition, portfolio, executedUsdc, executedSize, plan.executionPrice);
        this.logger.debug(`模拟成交 activityKey=${event.activityKey} price=${plan.executionPrice} size=${executedSize.toFixed(4)}`);
        return {
            status: 'confirmed',
            reason: request.note || '',
            requestedUsdc: plan.requestedUsdc,
            requestedSize: plan.requestedSize,
            executedUsdc,
            executedSize,
            executionPrice: plan.executionPrice,
            orderIds: [],
            transactionHashes: [],
            confirmedAt: Date.now(),
        };
    }

    async executeMerge(request: MergeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        await this.ledgerStore.ensurePortfolio(this.config.traceInitialBalance);
        const [portfolio, positions] = await Promise.all([
            this.ledgerStore.getPortfolio(),
            this.ledgerStore.listPositions(),
        ]);
        const snapshot = buildConditionPositionSnapshot(positions, event.conditionId);
        const requestedSize = Math.min(Math.max(Number(request.requestedSize) || 0, 0), snapshot.mergeableSize);
        if (requestedSize <= 0 || snapshot.positions.length < 2) {
            return emptyResult('本地缺少可 merge 的 complete set', request, event);
        }

        let nextCashBalance = portfolio.cashBalance + requestedSize;
        let nextRealizedPnl = portfolio.realizedPnl;
        const positionsByAsset = new Map(positions.map((position) => [position.asset, { ...position }]));

        for (const position of snapshot.positions) {
            const current = positionsByAsset.get(position.asset);
            if (!current) {
                continue;
            }

            const sizeBefore = Math.max(Number(current.size) || 0, 0);
            const releasedCostBasis = sizeBefore > 0 ? (Number(current.costBasis) || 0) * (requestedSize / sizeBefore) : 0;
            const proceedsShare = requestedSize / snapshot.positions.length;
            const realizedPnlDelta = proceedsShare - releasedCostBasis;
            current.size = normalizeSize(sizeBefore - requestedSize);
            current.costBasis = normalizeSize((Number(current.costBasis) || 0) - releasedCostBasis);
            current.realizedPnl = (Number(current.realizedPnl) || 0) + realizedPnlDelta;
            current.marketValue = current.size * Math.max(Number(current.marketPrice) || 0, 0);
            current.avgPrice = current.size > epsilon ? current.costBasis / current.size : 0;
            current.lastUpdatedAt = Date.now();
            nextRealizedPnl += realizedPnlDelta;

            if (current.size <= epsilon) {
                positionsByAsset.delete(current.asset);
                await this.ledgerStore.deletePosition(current.asset);
            } else {
                await this.ledgerStore.savePosition(current);
            }
        }

        const nextPositions = [...positionsByAsset.values()].filter((position) => position.size > epsilon);
        const nextPortfolio = buildPortfolioSnapshot(nextCashBalance, nextRealizedPnl, nextPositions);
        await this.ledgerStore.savePortfolio(nextPortfolio);

        return {
            status: 'confirmed',
            reason: request.note || '已完成 condition merge',
            requestedUsdc: requestedSize,
            requestedSize,
            executedUsdc: requestedSize,
            executedSize: requestedSize,
            executionPrice: 1,
            orderIds: [],
            transactionHashes: [],
            confirmedAt: Date.now(),
        };
    }

    private async applyTradeExecution(
        event: SourceTradeEvent,
        currentPosition: PositionSnapshot | null,
        currentPortfolio: PortfolioSnapshot,
        executedUsdc: number,
        executedSize: number,
        executionPrice: number
    ) {
        const positions = await this.ledgerStore.listPositions();
        const withoutCurrent = positions.filter((position) => position.asset !== event.asset);
        const basePosition: PositionSnapshot =
            currentPosition || {
                asset: event.asset,
                conditionId: event.conditionId,
                outcome: event.outcome,
                outcomeIndex: event.outcomeIndex,
                size: 0,
                avgPrice: 0,
                marketPrice: 0,
                marketValue: 0,
                costBasis: 0,
                realizedPnl: 0,
                redeemable: false,
                lastUpdatedAt: Date.now(),
            };

        let nextCashBalance = currentPortfolio.cashBalance;
        let nextRealizedPnl = currentPortfolio.realizedPnl;
        let nextPosition: PositionSnapshot | null = null;

        if (event.action === 'buy') {
            const totalCost = basePosition.costBasis + executedUsdc;
            const totalSize = basePosition.size + executedSize;
            nextCashBalance -= executedUsdc;
            nextPosition = {
                ...basePosition,
                size: totalSize,
                avgPrice: totalSize > epsilon ? totalCost / totalSize : 0,
                costBasis: totalCost,
                marketPrice: executionPrice,
                marketValue: totalSize * executionPrice,
                lastUpdatedAt: Date.now(),
            };
        } else {
            const sellSize = Math.min(executedSize, basePosition.size);
            const avgPrice = basePosition.size > epsilon ? basePosition.costBasis / basePosition.size : basePosition.avgPrice;
            const realizedPnlDelta = executedUsdc - avgPrice * sellSize;
            const remainingSize = Math.max(basePosition.size - sellSize, 0);
            const remainingCostBasis = Math.max(basePosition.costBasis - avgPrice * sellSize, 0);
            nextCashBalance += executedUsdc;
            nextRealizedPnl += realizedPnlDelta;
            nextPosition =
                remainingSize <= epsilon
                    ? null
                    : {
                          ...basePosition,
                          size: remainingSize,
                          avgPrice: remainingSize > epsilon ? remainingCostBasis / remainingSize : 0,
                          costBasis: remainingCostBasis,
                          marketPrice: executionPrice,
                          marketValue: remainingSize * executionPrice,
                          realizedPnl: basePosition.realizedPnl + realizedPnlDelta,
                          lastUpdatedAt: Date.now(),
                      };
        }

        if (nextPosition && nextPosition.size > epsilon) {
            await this.ledgerStore.savePosition(nextPosition);
        } else if (currentPosition) {
            await this.ledgerStore.deletePosition(currentPosition.asset);
        }

        const nextPositions = nextPosition ? [...withoutCurrent, nextPosition] : withoutCurrent;
        const nextPortfolio = buildPortfolioSnapshot(nextCashBalance, nextRealizedPnl, nextPositions);
        await this.ledgerStore.savePortfolio(nextPortfolio);
    }
}
