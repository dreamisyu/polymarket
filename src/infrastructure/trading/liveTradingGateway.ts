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
import type {
    UserExecutionConfirmationResult,
    UserExecutionFeed,
} from '../polymarket/userExecutionFeed';
import type { LoggerLike, TradingGateway } from '../runtime/contracts';
import {
    buildConditionPositionSnapshot,
    buildPortfolioSnapshot,
    findMatchingPosition,
    mapUserPosition,
} from './shared';
import { sleep } from '../../utils/sleep';

const emptyResult = (
    reason: string,
    request: { requestedUsdc?: number; requestedSize?: number },
    event: SourceTradeEvent
) => ({
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
    private submissionQueue: Promise<void> = Promise.resolve();
    private lastSubmissionStartedAt = 0;

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
            (positions || []).reduce(
                (sum, position) => sum + (Number(position.realizedPnl) || 0),
                0
            ),
            (positions || []).map(mapUserPosition)
        );
    }

    async getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null> {
        const positions = (await fetchUserPositions(this.config.sourceWallet, this.config)) || [];
        const matched = findMatchingPosition(positions, event);
        return matched ? mapUserPosition(matched) : null;
    }

    async getMarketSnapshot(assetId: string) {
        return this.marketFeed.getSnapshot(assetId);
    }

    async listConditionPositions(conditionId: string) {
        const positions = (
            (await fetchUserPositions(this.config.sourceWallet, this.config)) || []
        ).map(mapUserPosition);
        return buildConditionPositionSnapshot(positions, conditionId);
    }

    async executeTrade(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        if (event.action !== 'buy' && event.action !== 'sell') {
            return emptyResult('当前节点仅处理 BUY/SELL', request, event);
        }

        try {
            const response = await this.submitWithPacing(() =>
                this.clobClient.createAndPostMarketOrder(
                    {
                        side: request.side,
                        tokenID: event.asset,
                        amount: request.orderAmount,
                        price: request.executionPrice,
                    },
                    {
                        tickSize: request.tickSize,
                        negRisk: request.negRisk,
                    },
                    OrderType.FOK
                )
            );

            if (response.success !== true) {
                return {
                    ...emptyResult(orderFailureReason(response), request, event),
                    status: 'retry',
                    reason: orderFailureReason(response),
                };
            }

            const orderIds = response.orderID ? [response.orderID] : [];
            const transactionHashes = Array.isArray(response.transactionsHashes)
                ? response.transactionsHashes
                : [];
            const userConfirmation = await this.confirmViaUserFeed(event, orderIds);
            if (userConfirmation?.confirmationStatus === 'CONFIRMED') {
                const executedUsdc =
                    request.side === 'BUY'
                        ? request.orderAmount
                        : request.orderAmount * request.executionPrice;
                const executedSize =
                    request.side === 'BUY'
                        ? executedUsdc / Math.max(request.executionPrice, 0.0001)
                        : request.orderAmount;
                return {
                    status: 'confirmed',
                    reason: request.note || '',
                    requestedUsdc: request.requestedUsdc,
                    requestedSize: request.requestedSize,
                    executedUsdc,
                    executedSize,
                    executionPrice: request.executionPrice,
                    orderIds,
                    transactionHashes,
                    confirmedAt: userConfirmation.confirmedAt || Date.now(),
                    metadata: request.metadata,
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

            const executedUsdc =
                request.side === 'BUY'
                    ? request.orderAmount
                    : request.orderAmount * request.executionPrice;
            const executedSize =
                request.side === 'BUY'
                    ? executedUsdc / Math.max(request.executionPrice, 0.0001)
                    : request.orderAmount;
            return {
                status: 'confirmed',
                reason: request.note || '',
                requestedUsdc: request.requestedUsdc,
                requestedSize: request.requestedSize,
                executedUsdc,
                executedSize,
                executionPrice: request.executionPrice,
                orderIds,
                transactionHashes,
                confirmedAt: confirmation.confirmedAt,
                metadata: request.metadata,
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
        const requestedSize = Math.min(
            Math.max(Number(request.requestedSize) || 0, 0),
            conditionSnapshot.mergeableSize
        );
        if (requestedSize <= 0 || conditionSnapshot.positions.length < 2) {
            return emptyResult('本地缺少可 merge 的 complete set', request, event);
        }

        const partition = [
            ...new Set(
                conditionSnapshot.positions.map((position) => 1n << BigInt(position.outcomeIndex))
            ),
        ].sort((left, right) => Number(left - right));
        if (partition.length < 2) {
            return emptyResult('缺少完整 outcome partition，无法执行链上 merge', request, event);
        }

        try {
            const hash = await this.submitWithPacing(() =>
                submitConditionMerge(
                    {
                        conditionId: event.conditionId,
                        partition,
                        amount: requestedSize,
                    },
                    this.config
                )
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

    private async submitWithPacing<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.submissionQueue.catch(() => undefined);
        let release: (() => void) | null = null;
        this.submissionQueue = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;

        const waitMs = Math.max(
            this.lastSubmissionStartedAt + this.config.liveOrderMinIntervalMs - Date.now(),
            0
        );
        if (waitMs > 0) {
            await sleep(waitMs);
        }

        this.lastSubmissionStartedAt = Date.now();

        let taskPromise: Promise<T>;
        try {
            taskPromise = Promise.resolve(task());
        } catch (error) {
            release?.();
            throw error;
        }

        release?.();
        return taskPromise;
    }
}
