import { ClobClient, OrderType } from '@polymarket/clob-client';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type {
    MergeExecutionRequest,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
} from '../../domain';
import { confirmTransactionHashes } from '../chain/confirm';
import { submitConditionMerge } from '../chain/ctf';
import { getUsdcBalance } from '../chain/wallet';
import { fetchUserPositions } from '../polymarket/api';
import type { MarketBookFeed } from '../polymarket/marketBookFeed';
import type { UserExecutionConfirmationResult, UserExecutionFeed } from '../polymarket/userExecutionFeed';
import type { LoggerLike, TradingGateway } from '../runtime/contracts';
import { buildChunkExecutionPlan } from '../../utils/executionPlanning';
import { buildConditionPositionSnapshot, buildPortfolioSnapshot, findMatchingPosition, mapUserPosition } from './shared';

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

const orderFailureReason = (payload: unknown) =>
    String(
        (payload as { errorMsg?: string })?.errorMsg ||
            (payload as { error?: string })?.error ||
            (payload as { message?: string })?.message ||
            '下单接口返回失败'
    );

export class LiveTradingGateway implements TradingGateway {
    private readonly config: RuntimeConfig;
    private readonly logger: LoggerLike;
    private readonly clobClient: ClobClient;
    private readonly marketFeed: MarketBookFeed;
    private readonly userExecutionFeed: UserExecutionFeed | null;

    constructor(params: {
        config: RuntimeConfig;
        logger: LoggerLike;
        clobClient: ClobClient;
        marketFeed: MarketBookFeed;
        userExecutionFeed?: UserExecutionFeed | null;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.clobClient = params.clobClient;
        this.marketFeed = params.marketFeed;
        this.userExecutionFeed = params.userExecutionFeed || null;
    }

    async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
        const [positions, balance] = await Promise.all([
            fetchUserPositions(this.config.sourceWallet, this.config),
            getUsdcBalance(this.config.sourceWallet, this.config),
        ]);

        return buildPortfolioSnapshot(
            Math.max(Number(balance) || 0, 0),
            (positions || []).reduce((sum, position) => sum + (Number(position.realizedPnl) || 0), 0),
            (positions || []).map(mapUserPosition)
        );
    }

    async getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null> {
        const positions = (await fetchUserPositions(this.config.sourceWallet, this.config)) || [];
        const matched = findMatchingPosition(positions, event);
        return matched ? mapUserPosition(matched) : null;
    }

    async listConditionPositions(conditionId: string) {
        const positions = ((await fetchUserPositions(this.config.sourceWallet, this.config)) || []).map(mapUserPosition);
        return buildConditionPositionSnapshot(positions, conditionId);
    }

    async executeTrade(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        if (event.action !== 'buy' && event.action !== 'sell') {
            return emptyResult('当前节点仅处理 BUY/SELL', request, event);
        }

        const [positions, balance, marketSnapshot] = await Promise.all([
            fetchUserPositions(this.config.sourceWallet, this.config),
            getUsdcBalance(this.config.sourceWallet, this.config),
            this.marketFeed.getSnapshot(event.asset),
        ]);
        if (!marketSnapshot) {
            return {
                ...emptyResult('市场盘口不可用，稍后重试', request, event),
                status: 'retry',
                reason: '市场盘口不可用，稍后重试',
            };
        }
        const localPosition = findMatchingPosition(positions || [], event);
        const plan = buildChunkExecutionPlan({
            condition: event.action,
            trade: event,
            myPositionSize: Math.max(Number(localPosition?.size) || 0, 0),
            sourcePositionAfterTradeSize: Math.max(Number(event.sourcePositionSizeAfterTrade) || 0, 0),
            availableBalance: Math.max(Number(balance) || 0, 0),
            marketSnapshot,
            config: this.config,
            requestedUsdcOverride: request.requestedUsdc,
            requestedSizeOverride: request.requestedSize,
            sourcePriceOverride: event.price,
            noteOverride: request.note,
        });

        if (plan.status === 'SKIPPED') {
            return emptyResult(plan.reason, request, event);
        }
        if (plan.status !== 'READY' || !plan.side || !plan.tickSize) {
            return {
                ...emptyResult(plan.reason, request, event),
                status: 'retry',
                reason: plan.reason,
            };
        }

        try {
            const response = await this.clobClient.createAndPostMarketOrder(
                {
                    side: plan.side,
                    tokenID: event.asset,
                    amount: plan.orderAmount,
                    price: plan.executionPrice,
                },
                {
                    tickSize: plan.tickSize,
                    negRisk: plan.negRisk,
                },
                OrderType.FOK
            );

            if (response.success !== true) {
                return {
                    ...emptyResult(orderFailureReason(response), request, event),
                    status: 'retry',
                    reason: orderFailureReason(response),
                };
            }

            const orderIds = response.orderID ? [response.orderID] : [];
            const transactionHashes = Array.isArray(response.transactionsHashes) ? response.transactionsHashes : [];
            const userConfirmation = await this.confirmViaUserFeed(event, orderIds);
            if (userConfirmation?.confirmationStatus === 'CONFIRMED') {
                const executedUsdc = event.action === 'buy' ? plan.orderAmount : plan.orderAmount * plan.executionPrice;
                const executedSize =
                    event.action === 'buy'
                        ? executedUsdc / Math.max(plan.executionPrice, 0.0001)
                        : plan.orderAmount;
                return {
                    status: 'confirmed',
                    reason: request.note || '',
                    requestedUsdc: plan.requestedUsdc,
                    requestedSize: plan.requestedSize,
                    executedUsdc,
                    executedSize,
                    executionPrice: plan.executionPrice,
                    orderIds,
                    transactionHashes,
                    confirmedAt: userConfirmation.confirmedAt || Date.now(),
                };
            }
            if (userConfirmation?.confirmationStatus === 'FAILED') {
                return {
                    ...emptyResult(userConfirmation.reason, request, event),
                    status: 'failed',
                    reason: userConfirmation.reason,
                    orderIds,
                    transactionHashes,
                };
            }

            const confirmation = await confirmTransactionHashes(transactionHashes, this.config, {
                timeoutMs: this.config.liveConfirmTimeoutMs,
            });
            if (confirmation.status === 'FAILED') {
                return {
                    ...emptyResult(confirmation.reason, request, event),
                    status: 'failed',
                    reason: confirmation.reason,
                    orderIds,
                    transactionHashes,
                };
            }
            if (confirmation.status !== 'CONFIRMED') {
                this.logger.warn(`订单确认超时 activityKey=${event.activityKey}`);
                return {
                    ...emptyResult(confirmation.reason, request, event),
                    status: 'retry',
                    reason: confirmation.reason,
                    orderIds,
                    transactionHashes,
                };
            }

            const executedUsdc = event.action === 'buy' ? plan.orderAmount : plan.orderAmount * plan.executionPrice;
            const executedSize = event.action === 'buy' ? executedUsdc / Math.max(plan.executionPrice, 0.0001) : plan.orderAmount;
            return {
                status: 'confirmed',
                reason: request.note || '',
                requestedUsdc: plan.requestedUsdc,
                requestedSize: plan.requestedSize,
                executedUsdc,
                executedSize,
                executionPrice: plan.executionPrice,
                orderIds,
                transactionHashes,
                confirmedAt: confirmation.confirmedAt,
            };
        } catch (error) {
            this.logger.error({ err: error }, `下单异常 activityKey=${event.activityKey}`);
            return {
                ...emptyResult('下单异常，稍后重试', request, event),
                status: 'retry',
                reason: (error as { message?: string })?.message || '下单异常，稍后重试',
            };
        }
    }

    async executeMerge(request: MergeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        const conditionSnapshot = await this.listConditionPositions(event.conditionId);
        const requestedSize = Math.min(Math.max(Number(request.requestedSize) || 0, 0), conditionSnapshot.mergeableSize);
        if (requestedSize <= 0 || conditionSnapshot.positions.length < 2) {
            return emptyResult('本地缺少可 merge 的 complete set', request, event);
        }

        const partition = [...new Set(conditionSnapshot.positions.map((position) => 1n << BigInt(position.outcomeIndex)))].sort(
            (left, right) => Number(left - right)
        );
        if (partition.length < 2) {
            return emptyResult('缺少完整 outcome partition，无法执行链上 merge', request, event);
        }

        try {
            const hash = await submitConditionMerge(
                {
                    conditionId: event.conditionId,
                    partition,
                    amount: requestedSize,
                },
                this.config
            );
            const confirmation = await confirmTransactionHashes([hash], this.config, {
                timeoutMs: this.config.liveConfirmTimeoutMs,
            });
            if (confirmation.status === 'FAILED') {
                return {
                    ...emptyResult(confirmation.reason, request, event),
                    status: 'failed',
                    reason: confirmation.reason,
                    requestedSize,
                    requestedUsdc: requestedSize,
                    transactionHashes: [hash],
                };
            }
            if (confirmation.status !== 'CONFIRMED') {
                return {
                    ...emptyResult(confirmation.reason, request, event),
                    status: 'retry',
                    reason: confirmation.reason,
                    requestedSize,
                    requestedUsdc: requestedSize,
                    transactionHashes: [hash],
                };
            }

            return {
                status: 'confirmed',
                reason: request.note || '',
                requestedUsdc: requestedSize,
                requestedSize,
                executedUsdc: requestedSize,
                executedSize: requestedSize,
                executionPrice: 1,
                orderIds: [],
                transactionHashes: [hash],
                confirmedAt: confirmation.confirmedAt,
            };
        } catch (error) {
            this.logger.error({ err: error }, `链上 merge 异常 condition=${event.conditionId}`);
            return {
                ...emptyResult('链上 merge 提交失败', request, event),
                status: 'retry',
                reason: (error as { message?: string })?.message || '链上 merge 提交失败',
                requestedSize,
                requestedUsdc: requestedSize,
            };
        }
    }

    private async confirmViaUserFeed(
        event: SourceTradeEvent,
        orderIds: string[]
    ): Promise<UserExecutionConfirmationResult | null> {
        if (!this.userExecutionFeed || orderIds.length === 0) {
            return null;
        }

        try {
            return await this.userExecutionFeed.waitForOrders({
                conditionId: event.conditionId,
                orderIds,
                timeoutMs: this.config.liveConfirmTimeoutMs,
            });
        } catch (error) {
            this.logger.warn(
                `用户执行 websocket 确认失败，回退链上确认 activityKey=${event.activityKey}: ${
                    (error as { message?: string })?.message || 'unknown'
                }`
            );
            return null;
        }
    }
}
