import ClobMarketStream from '../../../services/clobMarketStream';
import { buildChunkExecutionPlan, cloneMarketSnapshot } from '../../../utils/executionPlanning';
import type { RefactorConfig } from '../../config/runtimeConfig';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
} from '../../domain/types';
import type { LedgerStore, LoggerLike, TradingGateway } from '../runtime/contracts';
import { buildPortfolioSnapshot } from './shared';

const EPSILON = 1e-8;

const toRequestedUsdc = (request: TradeExecutionRequest, event: SourceTradeEvent) =>
    Math.max(Number(request.requestedUsdc) || 0, 0) || Math.max(Number(event.usdcSize) || 0, 0);

const toRequestedSize = (request: TradeExecutionRequest, event: SourceTradeEvent) =>
    Math.max(Number(request.requestedSize) || 0, 0) || Math.max(Number(event.size) || 0, 0);

export class PaperTradingGateway implements TradingGateway {
    private readonly config: RefactorConfig;
    private readonly logger: LoggerLike;
    private readonly ledgerStore: LedgerStore;
    private readonly marketStream: ClobMarketStream;

    constructor(params: {
        config: RefactorConfig;
        logger: LoggerLike;
        ledgerStore: LedgerStore;
        marketStream: ClobMarketStream;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.ledgerStore = params.ledgerStore;
        this.marketStream = params.marketStream;
    }

    async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
        await this.ledgerStore.ensurePortfolio(this.config.traceInitialBalance);
        return this.ledgerStore.getPortfolio();
    }

    async getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null> {
        return this.ledgerStore.findPositionByAsset(event.asset);
    }

    async execute(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        if (event.action !== 'buy' && event.action !== 'sell') {
            return {
                status: 'skipped',
                reason: '当前版本仅对 TRADE BUY/SELL 走模拟交易网关',
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        await this.ledgerStore.ensurePortfolio(this.config.traceInitialBalance);
        const [portfolio, localPosition, marketSnapshot] = await Promise.all([
            this.ledgerStore.getPortfolio(),
            this.ledgerStore.findPositionByAsset(event.asset),
            this.marketStream.getSnapshot(event.asset),
        ]);

        if (!marketSnapshot) {
            return {
                status: 'retry',
                reason: '模拟盘口快照不可用',
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        const plan = buildChunkExecutionPlan({
            condition: event.action,
            trade: event as never,
            myPositionSize: Math.max(Number(localPosition?.size) || 0, 0),
            sourcePositionAfterTradeSize: Math.max(Number(event.sourcePositionSizeAfterTrade) || 0, 0),
            availableBalance: Math.max(Number(portfolio.cashBalance) || 0, 0),
            marketSnapshot: cloneMarketSnapshot(marketSnapshot),
            requestedUsdcOverride: request.requestedUsdc,
            requestedSizeOverride: request.requestedSize,
            sourcePriceOverride: event.price,
            noteOverride: request.note,
        });

        if (plan.status === 'SKIPPED') {
            return {
                status: 'skipped',
                reason: plan.reason,
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        if (plan.status !== 'READY') {
            return {
                status: 'retry',
                reason: plan.reason,
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        const executedUsdc = event.action === 'buy' ? plan.orderAmount : plan.orderAmount * plan.executionPrice;
        const executedSize =
            event.action === 'buy'
                ? executedUsdc / Math.max(plan.executionPrice || 0, 0.0001)
                : plan.orderAmount;
        const nextPosition = await this.applyExecution(
            event,
            localPosition,
            portfolio,
            executedUsdc,
            executedSize,
            plan.executionPrice
        );

        this.logger.debug(
            `模拟成交 activityKey=${event.activityKey} price=${plan.executionPrice} size=${executedSize.toFixed(4)}`
        );

        return {
            status: 'confirmed',
            reason: plan.note || request.note || '',
            requestedUsdc: plan.requestedUsdc,
            requestedSize: plan.requestedSize,
            executedUsdc,
            executedSize,
            executionPrice: plan.executionPrice,
            orderIds: [],
            transactionHashes: [],
            confirmedAt: Date.now(),
            metadata: nextPosition
                ? {
                      nextPositionSize: nextPosition.size,
                  }
                : undefined,
        };
    }

    private async applyExecution(
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
                avgPrice: totalSize > EPSILON ? totalCost / totalSize : 0,
                costBasis: totalCost,
                marketPrice: executionPrice,
                marketValue: totalSize * executionPrice,
                lastUpdatedAt: Date.now(),
            };
        } else {
            const sellSize = Math.min(executedSize, basePosition.size);
            const avgPrice = basePosition.size > EPSILON ? basePosition.costBasis / basePosition.size : basePosition.avgPrice;
            const realizedPnlDelta = executedUsdc - avgPrice * sellSize;
            const remainingSize = Math.max(basePosition.size - sellSize, 0);
            const remainingCostBasis = Math.max(basePosition.costBasis - avgPrice * sellSize, 0);
            nextCashBalance += executedUsdc;
            nextRealizedPnl += realizedPnlDelta;
            nextPosition =
                remainingSize <= EPSILON
                    ? null
                    : {
                          ...basePosition,
                          size: remainingSize,
                          avgPrice: remainingSize > EPSILON ? remainingCostBasis / remainingSize : 0,
                          costBasis: remainingCostBasis,
                          marketPrice: executionPrice,
                          marketValue: remainingSize * executionPrice,
                          realizedPnl: basePosition.realizedPnl + realizedPnlDelta,
                          lastUpdatedAt: Date.now(),
                      };
        }

        if (nextPosition && nextPosition.size > EPSILON) {
            await this.ledgerStore.savePosition(nextPosition);
        } else if (currentPosition) {
            await this.ledgerStore.deletePosition(currentPosition.asset);
        }

        const nextPositions = nextPosition ? [...withoutCurrent, nextPosition] : withoutCurrent;
        const nextPortfolio = buildPortfolioSnapshot(nextCashBalance, nextRealizedPnl, nextPositions);
        await this.ledgerStore.savePortfolio(nextPortfolio);
        return nextPosition;
    }
}
