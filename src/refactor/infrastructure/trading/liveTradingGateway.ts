import { ClobClient } from '@polymarket/clob-client';
import type { UserPositionInterface } from '../../../interfaces/User';
import ClobMarketStream from '../../../services/clobMarketStream';
import ClobUserStream from '../../../services/clobUserStream';
import confirmTransactionHashes from '../../../utils/confirmTransactionHashes';
import getMyBalance from '../../../utils/getMyBalance';
import postOrder from '../../../utils/postOrder';
import type { RefactorConfig } from '../../config/runtimeConfig';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
} from '../../domain/types';
import type { LoggerLike, TradingGateway } from '../runtime/contracts';
import { fetchPositions } from '../api/polymarketDataApi';
import { buildPortfolioSnapshot, findMatchingPosition, mapUserPosition } from './shared';

const toReason = (reason: string, fallback: string) => String(reason || '').trim() || fallback;

const toRequestedSize = (request: TradeExecutionRequest, event: SourceTradeEvent) =>
    Math.max(Number(request.requestedSize) || 0, 0) || Math.max(Number(event.size) || 0, 0);

const toRequestedUsdc = (request: TradeExecutionRequest, event: SourceTradeEvent) =>
    Math.max(Number(request.requestedUsdc) || 0, 0) || Math.max(Number(event.usdcSize) || 0, 0);

export class LiveTradingGateway implements TradingGateway {
    private readonly config: RefactorConfig;
    private readonly logger: LoggerLike;
    private readonly clobClient: ClobClient;
    private readonly marketStream: ClobMarketStream;
    private readonly userStream: ClobUserStream | null;

    constructor(params: {
        config: RefactorConfig;
        logger: LoggerLike;
        clobClient: ClobClient;
        marketStream: ClobMarketStream;
        userStream: ClobUserStream | null;
    }) {
        this.config = params.config;
        this.logger = params.logger;
        this.clobClient = params.clobClient;
        this.marketStream = params.marketStream;
        this.userStream = params.userStream;
    }

    async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
        const [positions, balance] = await Promise.all([
            fetchPositions(this.config.targetWallet),
            getMyBalance(this.config.targetWallet),
        ]);

        return buildPortfolioSnapshot(
            Math.max(Number(balance) || 0, 0),
            positions.reduce((sum, position) => sum + (Number(position.realizedPnl) || 0), 0),
            positions.map(mapUserPosition)
        );
    }

    async getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null> {
        const positions = await fetchPositions(this.config.targetWallet);
        const matched = findMatchingPosition(positions, event);
        return matched ? mapUserPosition(matched) : null;
    }

    async execute(request: TradeExecutionRequest): Promise<TradeExecutionResult> {
        const event = request.sourceEvent;
        if (event.action !== 'buy' && event.action !== 'sell') {
            return {
                status: 'skipped',
                reason: '当前版本仅对 TRADE BUY/SELL 走新交易网关',
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        const [positions, balance] = await Promise.all([
            fetchPositions(this.config.targetWallet),
            getMyBalance(this.config.targetWallet),
        ]);
        const localPosition = findMatchingPosition(positions, event);
        const postResult = await postOrder(
            this.clobClient,
            this.marketStream,
            event.action,
            localPosition as Pick<UserPositionInterface, 'asset' | 'size'> | undefined,
            { size: event.sourcePositionSizeAfterTrade },
            event as never,
            Math.max(Number(balance) || 0, 0),
            {
                requestedUsdc: request.requestedUsdc,
                requestedSize: request.requestedSize,
                sourcePrice: event.price,
                note: request.note,
            }
        );

        if (postResult.status === 'SKIPPED') {
            return {
                status: 'skipped',
                reason: toReason(postResult.reason, '执行计划判定为跳过'),
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
        }

        if (postResult.status === 'RETRYABLE_ERROR') {
            return {
                status: 'retry',
                reason: toReason(postResult.reason, '下单网关返回可重试错误'),
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
            };
        }

        if (postResult.status === 'FAILED') {
            return {
                status: 'failed',
                reason: toReason(postResult.reason, '下单网关返回失败'),
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
            };
        }

        const confirmationFromUserStream =
            this.userStream && postResult.orderIds.length > 0
                ? await this.userStream.waitForOrders({
                      conditionId: event.conditionId,
                      orderIds: postResult.orderIds,
                      timeoutMs: this.config.liveConfirmTimeoutMs,
                  })
                : null;

        if (confirmationFromUserStream?.confirmationStatus === 'CONFIRMED') {
            return {
                status: 'confirmed',
                reason: postResult.reason,
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: toRequestedUsdc(request, event),
                executedSize:
                    event.action === 'buy'
                        ? toRequestedUsdc(request, event) / Math.max(Number(event.price) || 1, 0.0001)
                        : toRequestedSize(request, event),
                executionPrice: Math.max(Number(event.price) || 0, 0),
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
                matchedAt: confirmationFromUserStream.matchedAt,
                minedAt: confirmationFromUserStream.minedAt,
                confirmedAt: confirmationFromUserStream.confirmedAt,
            };
        }

        if (confirmationFromUserStream?.confirmationStatus === 'FAILED') {
            return {
                status: 'failed',
                reason: toReason(confirmationFromUserStream.reason, 'User Channel 返回失败'),
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
            };
        }

        const confirmationFromChain = await confirmTransactionHashes(postResult.transactionHashes, {
            timeoutMs: this.config.liveConfirmTimeoutMs,
        });

        if (confirmationFromChain.status === 'CONFIRMED') {
            return {
                status: 'confirmed',
                reason: postResult.reason,
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: toRequestedUsdc(request, event),
                executedSize:
                    event.action === 'buy'
                        ? toRequestedUsdc(request, event) / Math.max(Number(event.price) || 1, 0.0001)
                        : toRequestedSize(request, event),
                executionPrice: Math.max(Number(event.price) || 0, 0),
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
                confirmedAt: confirmationFromChain.confirmedAt,
            };
        }

        if (confirmationFromChain.status === 'FAILED') {
            return {
                status: 'failed',
                reason: toReason(confirmationFromChain.reason, '链上确认失败'),
                requestedUsdc: toRequestedUsdc(request, event),
                requestedSize: toRequestedSize(request, event),
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: postResult.orderIds,
                transactionHashes: postResult.transactionHashes,
            };
        }

        this.logger.warn(
            `链上确认超时 activityKey=${event.activityKey} delay=${this.config.liveReconcileAfterTimeoutMs}ms`
        );
        return {
            status: 'retry',
            reason: toReason(
                confirmationFromUserStream?.reason || confirmationFromChain.reason,
                '等待成交确认超时，稍后重试'
            ),
            requestedUsdc: toRequestedUsdc(request, event),
            requestedSize: toRequestedSize(request, event),
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: 0,
            orderIds: postResult.orderIds,
            transactionHashes: postResult.transactionHashes,
        };
    }
}
