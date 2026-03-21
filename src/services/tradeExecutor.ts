import mongoose from 'mongoose';
import { ClobClient } from '@polymarket/clob-client';
import {
    CopyExecutionBatchInterface,
    CopyIntentBufferInterface,
    ExecutionPolicyTrailEntry,
} from '../interfaces/Execution';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getCopyExecutionBatchModel, getCopyIntentBufferModel } from '../models/copyExecution';
import { getUserActivityModel } from '../models/userHistory';
import ClobMarketStream from './clobMarketStream';
import ClobUserStream, { UserChannelStatusUpdate } from './clobUserStream';
import LivePersistenceQueue from './livePersistenceQueue';
import LiveStateStore, { BOOTSTRAP_POLICY_IDS, LiveTradeRuntimeState } from './liveStateStore';
import confirmTransactionHashes from '../utils/confirmTransactionHashes';
import { evaluateDirectBuyIntent, sortTradesAsc } from '../utils/copyIntentPlanning';
import { buildPolicyTrailEntry, hasPolicyId, mergePolicyTrail } from '../utils/executionPolicy';
import fetchData from '../utils/fetchData';
import getTradingGuardState from '../utils/getTradingGuardState';
import createLogger from '../utils/logger';
import postOrder from '../utils/postOrder';
import {
    fetchPolymarketMarketResolution,
    isResolvedPolymarketMarket,
    isTradablePolymarketMarket,
    normalizeOutcomeLabel,
} from '../utils/polymarketMarketResolution';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import {
    getSourceActivityKeys,
    getSourceEndedAt,
    getSourceStartedAt,
    getSourceTradeCount,
    getSourceTransactionHashes,
} from '../utils/sourceActivityAggregation';
import {
    formatAmount,
    mergeReasons,
    mergeStringArrays,
    sleep,
    toSafeNumber,
} from '../utils/runtime';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const MIN_MARKET_BUY_USDC = 1;
const BUY_INTENT_BUFFER_MAX_MS = ENV.BUY_INTENT_BUFFER_MAX_MS;
const BUY_MIN_TOP_UP_TRIGGER_USDC = ENV.BUY_MIN_TOP_UP_TRIGGER_USDC;
const BUY_BOOTSTRAP_MAX_ACTIVE_RATIO = ENV.BUY_BOOTSTRAP_MAX_ACTIVE_RATIO;
const LOOP_INTERVAL_MS = ENV.LIVE_EXECUTOR_LOOP_INTERVAL_MS;
const CONTEXT_TTL_MS = ENV.LIVE_STATE_REFRESH_MS;
const EPSILON = 1e-8;
const NO_LIQUIDITY_REASONS = [
    '盘口暂无卖单',
    '盘口暂无买单',
    '盘口可成交金额不足',
    '盘口可成交数量不足',
];
const SOURCE_TRADE_BUFFER_POLICY_ID = 'source-trade-merge';
const LIVE_BUY_BUFFER_POLICY_ID = 'live-buy-intent-buffer';
const BUFFER_MIN_TOP_UP_POLICY_ID = 'buffer-min-top-up';
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}&sizeThreshold=0`;
const logger = createLogger('live');

const UserActivity = getUserActivityModel(USER_ADDRESS);
const CopyIntentBuffer = getCopyIntentBufferModel(USER_ADDRESS);
const CopyExecutionBatch = getCopyExecutionBatchModel(USER_ADDRESS);

interface TradingContext {
    positions: UserPositionInterface[];
    availableBalance: number | null;
    skipReason: string;
    totalEquity: number;
    refreshedAt: number;
}

const findPositionForTrade = (
    positions: UserPositionInterface[],
    trade: Pick<UserActivityInterface, 'asset' | 'conditionId' | 'outcomeIndex' | 'outcome'>
): UserPositionInterface | undefined =>
    positions.find((position) => position.asset === trade.asset) ||
    positions.find(
        (position) =>
            position.conditionId === trade.conditionId &&
            position.outcomeIndex === trade.outcomeIndex
    ) ||
    positions.find(
        (position) =>
            position.conditionId === trade.conditionId &&
            normalizeOutcomeLabel(position.outcome) === normalizeOutcomeLabel(trade.outcome)
    );

const formatTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset' | 'side'>) =>
    `tx=${trade.transactionHash} side=${String(trade.side || '').toUpperCase()} asset=${trade.asset}`;

const formatBatchRef = (
    batch: Pick<CopyExecutionBatchInterface, 'asset' | 'condition' | 'sourceTradeCount'>
) => `condition=${batch.condition} asset=${batch.asset} trades=${batch.sourceTradeCount}`;

const formatTerminalStatus = (status: 'CONFIRMED' | 'SKIPPED' | 'FAILED') =>
    status === 'CONFIRMED' ? '已确认' : status === 'SKIPPED' ? '已跳过' : '已失败';

const buildLiveBuyBufferKey = (trade: Pick<UserActivityInterface, 'asset' | 'conditionId'>) =>
    `buy:${trade.conditionId}:${trade.asset}`;

const shouldFlushBufferBeforeAppendingTrade = (
    buffer: Pick<CopyIntentBufferInterface, 'sourceEndedAt'>,
    trade: Pick<UserActivityInterface, 'timestamp'>
) =>
    toSafeNumber(buffer.sourceEndedAt) > 0 &&
    trade.timestamp > toSafeNumber(buffer.sourceEndedAt) &&
    trade.timestamp - toSafeNumber(buffer.sourceEndedAt) > BUY_INTENT_BUFFER_MAX_MS;

const isNoLiquidityReason = (reason: string) =>
    NO_LIQUIDITY_REASONS.some((token) => reason.includes(token));

const serializeBuffer = (buffer: CopyIntentBufferInterface) => {
    const { _id, ...rest } = buffer;
    return rest;
};

const serializeBatch = (batch: CopyExecutionBatchInterface) => {
    const { _id, ...rest } = batch;
    return rest;
};

const buildBootstrapBudgetRemainingUsdc = (context: TradingContext, stateStore: LiveStateStore) => {
    const activeBootstrapExposureUsdc = stateStore.activeBootstrapExposureUsdc();
    return Math.max(
        context.totalEquity * BUY_BOOTSTRAP_MAX_ACTIVE_RATIO - activeBootstrapExposureUsdc,
        0
    );
};

const validateTradeForExecution = (trade: UserActivityInterface) => {
    if (trade.snapshotStatus && trade.snapshotStatus !== 'COMPLETE') {
        return {
            status: 'SKIP' as const,
            reason:
                trade.sourceSnapshotReason ||
                `源账户快照状态为 ${trade.snapshotStatus}，已跳过真实执行`,
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
        !Number.isFinite(trade.sourceBalanceBeforeTrade) &&
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

class LiveTradeExecutorRuntime {
    private readonly clobClient: ClobClient;
    private readonly marketStream: ClobMarketStream;
    private readonly userStream: ClobUserStream | null;
    private readonly stateStore = new LiveStateStore();
    private readonly persistenceQueue = new LivePersistenceQueue({
        maxQueueSize: ENV.LIVE_PERSIST_MAX_QUEUE_SIZE,
        retryDelayMs: ENV.LIVE_PERSIST_RETRY_MS,
    });
    private readonly executingBatchIds = new Set<string>();
    private readonly confirmingBatchIds = new Set<string>();
    private readonly marketResolutionCache = new Map<
        string,
        {
            updatedAt: number;
            resolution: Awaited<ReturnType<typeof fetchPolymarketMarketResolution>>;
        }
    >();
    private tradingContext: TradingContext = {
        positions: [],
        availableBalance: null,
        skipReason: '',
        totalEquity: 0,
        refreshedAt: 0,
    };

    constructor(
        clobClient: ClobClient,
        marketStream: ClobMarketStream,
        userStream: ClobUserStream | null
    ) {
        this.clobClient = clobClient;
        this.marketStream = marketStream;
        this.userStream = userStream;
    }

    ingestSourceTrades = (trades: UserActivityInterface[]) => {
        const executableTrades = trades.filter(
            (trade) =>
                String(trade.type || '').toUpperCase() === 'TRADE' &&
                (trade.executionIntent === 'EXECUTE' || !trade.executionIntent)
        );
        const accepted = this.stateStore.ingestTrades(executableTrades);
        if (accepted > 0) {
            logger.debug(`内存队列新增源交易 ${accepted} 条`);
        }
    };

    async run() {
        logger.info('启动真实跟单（内存主状态 + 异步持久化）');
        await this.hydrateRecoveryState();

        while (true) {
            try {
                await this.refreshTradingContext();
                const pendingTrades = this.stateStore.listPendingTrades();
                if (pendingTrades.length > 0) {
                    await this.processPendingTrades(pendingTrades);
                }

                await this.flushDueBuyBuffers();
                this.executeReadyBatches();
                this.syncSubmittedBatches();
            } catch (error) {
                logger.error('实盘执行主循环异常', error);
            }

            await sleep(LOOP_INTERVAL_MS);
        }
    }

    private async hydrateRecoveryState() {
        const [recoverableTrades, openBuffers, activeBatches] = await Promise.all([
            UserActivity.find({
                $and: [
                    { type: 'TRADE' },
                    {
                        $or: [
                            { executionIntent: 'EXECUTE' },
                            { executionIntent: { $exists: false } },
                        ],
                    },
                    { transactionHash: { $exists: true, $ne: '' } },
                    {
                        $or: [
                            { botStatus: { $exists: false } },
                            {
                                botStatus: {
                                    $in: [
                                        'PENDING',
                                        'PROCESSING',
                                        'BUFFERED',
                                        'BATCHED',
                                        'SUBMITTED',
                                    ],
                                },
                            },
                        ],
                    },
                ],
            })
                .sort({ timestamp: 1 })
                .exec() as Promise<UserActivityInterface[]>,
            CopyIntentBuffer.find({
                state: 'OPEN',
                condition: 'buy',
            })
                .sort({ sourceStartedAt: 1, createdAt: 1 })
                .exec() as Promise<CopyIntentBufferInterface[]>,
            CopyExecutionBatch.find({
                status: { $in: ['READY', 'PROCESSING', 'SUBMITTED'] },
            })
                .sort({ sourceStartedAt: 1, createdAt: 1 })
                .exec() as Promise<CopyExecutionBatchInterface[]>,
        ]);

        this.stateStore.ingestTrades(recoverableTrades);
        for (const buffer of openBuffers) {
            const normalizedBuffer =
                typeof (
                    buffer as CopyIntentBufferInterface & {
                        toObject?: () => CopyIntentBufferInterface;
                    }
                ).toObject === 'function'
                    ? (
                          buffer as CopyIntentBufferInterface & {
                              toObject: () => CopyIntentBufferInterface;
                          }
                      ).toObject()
                    : buffer;
            this.stateStore.createOrUpdateBuffer({
                ...normalizedBuffer,
                state: 'OPEN',
                claimedAt: 0,
            });
        }

        for (const batch of activeBatches) {
            const normalizedBatch =
                typeof (
                    batch as CopyExecutionBatchInterface & {
                        toObject?: () => CopyExecutionBatchInterface;
                    }
                ).toObject === 'function'
                    ? (
                          batch as CopyExecutionBatchInterface & {
                              toObject: () => CopyExecutionBatchInterface;
                          }
                      ).toObject()
                    : batch;
            this.stateStore.createBatch({
                ...normalizedBatch,
                status: normalizedBatch.status === 'PROCESSING' ? 'READY' : normalizedBatch.status,
                claimedAt: 0,
            });
        }

        if (recoverableTrades.length > 0 || openBuffers.length > 0 || activeBatches.length > 0) {
            logger.warn(
                `已恢复 live 状态 trades=${recoverableTrades.length} buffers=${openBuffers.length} batches=${activeBatches.length}`
            );
        }
    }

    private async refreshTradingContext(force = false) {
        if (!force && Date.now() - this.tradingContext.refreshedAt < CONTEXT_TTL_MS) {
            return this.tradingContext;
        }

        const [positionsRaw, guardState] = await Promise.all([
            fetchData<UserPositionInterface[]>(PROXY_POSITIONS_URL),
            getTradingGuardState(this.clobClient),
        ]);
        const positions = Array.isArray(positionsRaw)
            ? positionsRaw
            : this.tradingContext.positions;
        this.stateStore.updateProxyPositions(positions);

        const totalPositionValue = positions.reduce(
            (sum, position) => sum + Math.max(toSafeNumber(position.currentValue), 0),
            0
        );
        const availableBalance = guardState.availableBalance;
        this.tradingContext = {
            positions,
            availableBalance,
            skipReason: guardState.skipReason,
            totalEquity: Math.max(toSafeNumber(availableBalance), 0) + totalPositionValue,
            refreshedAt: Date.now(),
        };

        return this.tradingContext;
    }

    private queuePersistBuffer(buffer: CopyIntentBufferInterface) {
        this.persistenceQueue.enqueue(`buffer:${String(buffer._id)}`, async () => {
            await CopyIntentBuffer.updateOne(
                { _id: buffer._id },
                {
                    $set: serializeBuffer(buffer),
                },
                {
                    upsert: true,
                }
            );
        });
    }

    private queuePersistBatch(batch: CopyExecutionBatchInterface) {
        this.persistenceQueue.enqueue(`batch:${String(batch._id)}`, async () => {
            await CopyExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: serializeBatch(batch),
                },
                {
                    upsert: true,
                }
            );
        });
    }

    private queuePersistActivityUpdate(
        tradeIds: mongoose.Types.ObjectId[],
        update: Record<string, unknown>
    ) {
        if (tradeIds.length === 0) {
            return;
        }

        this.persistenceQueue.enqueue(`activity:${tradeIds.length}`, async () => {
            await UserActivity.updateMany(
                {
                    _id: { $in: tradeIds },
                },
                {
                    $set: update,
                }
            );
        });
    }

    private queuePersistSingleTradeState(state: LiveTradeRuntimeState) {
        this.queuePersistActivityUpdate([state.trade._id], {
            bot:
                state.status === 'CONFIRMED' ||
                state.status === 'SKIPPED' ||
                state.status === 'FAILED',
            botStatus: state.status,
            botExcutedTime: state.retryCount,
            botClaimedAt: 0,
            botExecutedAt: state.executedAt || 0,
            botLastError: state.lastError,
            botOrderIds: state.orderIds,
            botTransactionHashes: state.transactionHashes,
            botSubmittedAt: state.submittedAt || 0,
            botConfirmedAt: state.confirmedAt || 0,
            botMatchedAt: state.matchedAt || 0,
            botMinedAt: state.minedAt || 0,
            botBufferId: state.bufferId,
            botExecutionBatchId: state.batchId,
            botPolicyTrail: state.policyTrail,
        });
    }

    private queuePersistTradesByBatch(batch: CopyExecutionBatchInterface, statusOverride?: string) {
        this.queuePersistActivityUpdate(batch.sourceTradeIds, {
            bot:
                statusOverride === 'CONFIRMED' ||
                statusOverride === 'SKIPPED' ||
                statusOverride === 'FAILED',
            botStatus: statusOverride || batch.status,
            botClaimedAt: 0,
            botExecutionBatchId: batch._id,
            botBufferId: batch.bufferId,
            botLastError: batch.reason,
            botOrderIds: batch.orderIds,
            botTransactionHashes: batch.transactionHashes,
            botSubmittedAt: batch.submittedAt || 0,
            botConfirmedAt: batch.confirmedAt || 0,
            botMatchedAt: 0,
            botMinedAt: 0,
            botSubmissionStatus: batch.submissionStatus || 'SUBMITTED',
            botPolicyTrail: batch.policyTrail || [],
            ...(statusOverride === 'CONFIRMED' ||
            statusOverride === 'SKIPPED' ||
            statusOverride === 'FAILED'
                ? {
                      botExecutedAt: batch.completedAt || Date.now(),
                  }
                : {}),
        });
    }

    private queuePersistBatchProgress(
        batch: CopyExecutionBatchInterface,
        update: UserChannelStatusUpdate
    ) {
        this.persistenceQueue.enqueue(`batch-progress:${String(batch._id)}`, async () => {
            await CopyExecutionBatch.updateOne(
                { _id: batch._id },
                {
                    $set: {
                        reason: update.reason,
                        ...(update.status && update.status !== 'SUBMITTED'
                            ? { submissionStatus: update.status }
                            : {}),
                        ...(update.confirmedAt ? { confirmedAt: update.confirmedAt } : {}),
                    },
                }
            );
            await UserActivity.updateMany(
                {
                    _id: { $in: batch.sourceTradeIds },
                },
                {
                    $set: {
                        botLastError: update.reason,
                        ...(update.status && update.status !== 'SUBMITTED'
                            ? { botSubmissionStatus: update.status }
                            : {}),
                        ...(update.matchedAt ? { botMatchedAt: update.matchedAt } : {}),
                        ...(update.minedAt ? { botMinedAt: update.minedAt } : {}),
                        ...(update.confirmedAt ? { botConfirmedAt: update.confirmedAt } : {}),
                    },
                }
            );
        });
    }

    private async loadMarketResolution(trade: UserActivityInterface) {
        const cacheKey = `${trade.conditionId}:${String(trade.eventSlug || trade.slug || '').trim()}`;
        const cached = this.marketResolutionCache.get(cacheKey);
        if (cached && Date.now() - cached.updatedAt < 30_000) {
            return cached.resolution;
        }

        const resolution = await fetchPolymarketMarketResolution({
            conditionId: trade.conditionId,
            marketSlug: String(trade.eventSlug || trade.slug || '').trim(),
            title: trade.title,
        });
        this.marketResolutionCache.set(cacheKey, {
            updatedAt: Date.now(),
            resolution,
        });
        return resolution;
    }

    private finalizeTradeState(
        state: LiveTradeRuntimeState,
        status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
        reason: string,
        policyTrail: ExecutionPolicyTrailEntry[] = state.policyTrail,
        confirmedAt?: number
    ) {
        state.status = status;
        state.lastError = reason;
        state.policyTrail = policyTrail;
        state.executedAt = Date.now();
        state.confirmedAt = confirmedAt || state.confirmedAt;
        this.queuePersistSingleTradeState(state);

        const message = [
            `${formatTradeRef(state.trade)} ${formatTerminalStatus(status)}`,
            reason ? `reason=${reason}` : '',
            confirmedAt ? `confirmedAt=${confirmedAt}` : '',
        ]
            .filter(Boolean)
            .join(' ');
        if (status === 'FAILED') {
            logger.error(message);
            return;
        }

        logger.debug(message);
    }

    private finalizeBatch(
        batch: CopyExecutionBatchInterface,
        status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
        reason: string,
        confirmedAt?: number
    ) {
        const finalizedBatch = this.stateStore.markBatchTerminal(
            batch._id,
            status,
            reason,
            confirmedAt
        );
        if (!finalizedBatch) {
            return;
        }

        this.queuePersistBatch(finalizedBatch);
        this.queuePersistTradesByBatch(finalizedBatch, status);
        this.stateStore.markTradesByBatch(finalizedBatch, {
            status,
            lastError: reason,
            confirmedAt,
            executedAt: finalizedBatch.completedAt,
            policyTrail: finalizedBatch.policyTrail || [],
            batchId: finalizedBatch._id,
        });

        if (status === 'CONFIRMED') {
            if (
                finalizedBatch.condition === 'buy' &&
                hasPolicyId(finalizedBatch.policyTrail, BOOTSTRAP_POLICY_IDS)
            ) {
                const trades = this.stateStore.getTradesByIds(finalizedBatch.sourceTradeIds);
                const latestTrade = sortTradesAsc(trades).slice(-1)[0];
                if (latestTrade) {
                    this.stateStore.markBootstrapExposure(
                        latestTrade,
                        finalizedBatch.requestedUsdc
                    );
                }
            }

            if (finalizedBatch.condition !== 'buy') {
                const trades = this.stateStore.getTradesByIds(finalizedBatch.sourceTradeIds);
                const latestTrade = sortTradesAsc(trades).slice(-1)[0];
                if (latestTrade) {
                    this.stateStore.markBootstrapExposure(latestTrade, 0);
                }
            }
        }

        const message = [
            `${formatBatchRef(finalizedBatch)} ${formatTerminalStatus(status)}`,
            reason ? `reason=${reason}` : '',
            confirmedAt ? `confirmedAt=${confirmedAt}` : '',
        ]
            .filter(Boolean)
            .join(' ');
        if (status === 'FAILED') {
            logger.error(message);
            return;
        }

        logger.debug(message);
    }

    private async cancelOpenBuyBuffersForAsset(
        trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
    ) {
        const buffers = this.stateStore.listOpenBuffersForAsset(trade.asset);
        if (buffers.length === 0) {
            return;
        }

        const reason = `检测到 asset=${trade.asset} 的非买入源交易，已放弃未执行的累计买单`;
        const trail = [
            buildPolicyTrailEntry(
                SOURCE_TRADE_BUFFER_POLICY_ID,
                'SKIP',
                `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已关闭累计缓冲`
            ),
        ];

        for (const buffer of buffers) {
            const mergedTrail = mergePolicyTrail(buffer.policyTrail, trail);
            this.stateStore.closeBuffer(buffer._id, 'SKIPPED', reason);
            buffer.policyTrail = mergedTrail;
            buffer.reason = reason;
            this.queuePersistBuffer(buffer);

            const trades = this.stateStore.getTradesByIds(buffer.sourceTradeIds);
            for (const sourceTrade of trades) {
                const state = this.stateStore.getTradeState(sourceTrade);
                if (!state) {
                    continue;
                }

                this.finalizeTradeState(state, 'SKIPPED', reason, mergedTrail);
            }
        }
    }

    private async cancelReadyBuyBatchesForAsset(
        trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
    ) {
        const batches = this.stateStore
            .listActiveBuyBatchesForAsset(trade.asset)
            .filter((batch) => batch.status !== 'SUBMITTED');
        if (batches.length === 0) {
            return;
        }

        const reason = `检测到 asset=${trade.asset} 的非买入源交易，已取消未执行的买入批次`;
        const trail = [
            buildPolicyTrailEntry(
                SOURCE_TRADE_BUFFER_POLICY_ID,
                'SKIP',
                `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已取消待执行买入批次`
            ),
        ];

        for (const batch of batches) {
            batch.policyTrail = mergePolicyTrail(batch.policyTrail, trail);
            batch.reason = reason;
            this.finalizeBatch(batch, 'SKIPPED', reason);
        }
    }

    private async createBatch(params: {
        trades: UserActivityInterface[];
        condition?: string;
        requestedUsdc?: number;
        requestedSize?: number;
        sourcePrice?: number;
        reason?: string;
        policyTrail?: ExecutionPolicyTrailEntry[];
        bufferId?: mongoose.Types.ObjectId;
    }) {
        const orderedTrades = sortTradesAsc(params.trades);
        const latestTrade = orderedTrades.slice(-1)[0];
        if (!latestTrade) {
            return null;
        }

        const condition =
            params.condition ||
            resolveTradeCondition(latestTrade.side, undefined, {
                size: latestTrade.sourcePositionSizeAfterTrade,
            });
        const batch: CopyExecutionBatchInterface = {
            _id: new mongoose.Types.ObjectId(),
            sourceWallet: USER_ADDRESS,
            bufferId: params.bufferId,
            status: 'READY',
            condition,
            asset: latestTrade.asset,
            conditionId: latestTrade.conditionId,
            title: latestTrade.title,
            outcome: latestTrade.outcome,
            side: latestTrade.side,
            sourceTradeIds: orderedTrades.map((trade) => trade._id),
            sourceActivityKeys: mergeStringArrays(
                ...orderedTrades.map((trade) => getSourceActivityKeys(trade))
            ),
            sourceTransactionHashes: mergeStringArrays(
                ...orderedTrades.map((trade) => getSourceTransactionHashes(trade))
            ),
            sourceTradeCount: orderedTrades.reduce(
                (sum, trade) => sum + getSourceTradeCount(trade),
                0
            ),
            sourceStartedAt: Math.min(...orderedTrades.map((trade) => getSourceStartedAt(trade))),
            sourceEndedAt: Math.max(...orderedTrades.map((trade) => getSourceEndedAt(trade))),
            sourcePrice: Math.max(
                toSafeNumber(params.sourcePrice),
                toSafeNumber(latestTrade.price),
                0
            ),
            requestedUsdc: Math.max(toSafeNumber(params.requestedUsdc), 0),
            requestedSize: Math.max(toSafeNumber(params.requestedSize), 0),
            orderIds: [],
            transactionHashes: [],
            policyTrail: params.policyTrail || [],
            retryCount: 0,
            claimedAt: 0,
            submittedAt: 0,
            confirmedAt: 0,
            completedAt: 0,
            reason: params.reason || '',
            submissionStatus: 'SUBMITTED',
        };
        this.stateStore.createBatch(batch);
        this.queuePersistBatch(batch);
        this.queuePersistTradesByBatch(batch, 'BATCHED');
        logger.debug(
            `${formatTradeRef(latestTrade)} 已创建实盘批次 requestedUsdc=${formatAmount(batch.requestedUsdc)}` +
                (batch.reason ? ` reason=${batch.reason}` : '')
        );
        return batch;
    }

    private async flushBuyBuffer(
        buffer: CopyIntentBufferInterface,
        options: { skipReason?: string; extraPolicyTrail?: ExecutionPolicyTrailEntry[] } = {}
    ) {
        const trades = this.stateStore.getTradesByIds(buffer.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        if (!latestTrade) {
            buffer.state = 'SKIPPED';
            buffer.reason = options.skipReason || '累计缓冲缺少关联源交易';
            buffer.completedAt = Date.now();
            this.stateStore.closeBuffer(buffer._id, 'SKIPPED', buffer.reason);
            this.queuePersistBuffer(buffer);
            return;
        }

        const context = await this.refreshTradingContext(true);
        const existingPosition = findPositionForTrade(context.positions, latestTrade);
        const activeBuyBatch = this.stateStore.getActiveBuyBatch(latestTrade);
        const bufferedRequestedUsdc = Math.max(toSafeNumber(buffer.requestedUsdc), 0);
        const availableBalance = Math.max(
            toSafeNumber(context.availableBalance) -
                Math.max(this.stateStore.reservedBuyExposureUsdc() - bufferedRequestedUsdc, 0),
            0
        );
        const bootstrapBudgetRemainingUsdc = buildBootstrapBudgetRemainingUsdc(
            context,
            this.stateStore
        );
        const canTopUpBufferedBuy =
            bufferedRequestedUsdc >= BUY_MIN_TOP_UP_TRIGGER_USDC &&
            bufferedRequestedUsdc < MIN_MARKET_BUY_USDC &&
            Math.max(toSafeNumber(existingPosition?.size), 0) <= EPSILON &&
            activeBuyBatch === null &&
            availableBalance >= MIN_MARKET_BUY_USDC &&
            bootstrapBudgetRemainingUsdc + EPSILON >= MIN_MARKET_BUY_USDC;
        const finalRequestedUsdc = canTopUpBufferedBuy
            ? MIN_MARKET_BUY_USDC
            : bufferedRequestedUsdc;
        const finalReason = canTopUpBufferedBuy
            ? mergeReasons(
                  buffer.reason,
                  `累计买单 ${formatAmount(buffer.requestedUsdc)} USDC，已按最小买单门槛补齐到 1 USDC`
              )
            : buffer.reason || '';
        const finalPolicyTrail = canTopUpBufferedBuy
            ? mergePolicyTrail(buffer.policyTrail, options.extraPolicyTrail, [
                  buildPolicyTrailEntry(
                      BUFFER_MIN_TOP_UP_POLICY_ID,
                      'ADJUST',
                      `累计买单 ${formatAmount(buffer.requestedUsdc)} USDC，已补齐到 1 USDC`
                  ),
              ])
            : mergePolicyTrail(buffer.policyTrail, options.extraPolicyTrail);

        if (finalRequestedUsdc < MIN_MARKET_BUY_USDC) {
            const reason =
                options.skipReason ||
                mergeReasons(
                    finalReason,
                    `累计买单 ${formatAmount(buffer.requestedUsdc)} USDC 未达到 ${MIN_MARKET_BUY_USDC} USDC`
                );
            this.stateStore.closeBuffer(buffer._id, 'SKIPPED', reason);
            buffer.state = 'SKIPPED';
            buffer.reason = reason;
            buffer.policyTrail = finalPolicyTrail;
            buffer.completedAt = Date.now();
            this.queuePersistBuffer(buffer);
            for (const trade of trades) {
                const state = this.stateStore.getTradeState(trade);
                if (state) {
                    this.finalizeTradeState(state, 'SKIPPED', reason, finalPolicyTrail);
                }
            }
            logger.debug(`${buffer.bufferKey} 已放弃 live 累计缓冲 reason=${reason}`);
            return;
        }

        await this.createBatch({
            trades,
            bufferId: buffer._id,
            condition: 'buy',
            requestedUsdc: finalRequestedUsdc,
            sourcePrice: Math.max(
                toSafeNumber(buffer.sourcePrice),
                toSafeNumber(latestTrade.price),
                0
            ),
            reason: finalReason,
            policyTrail: finalPolicyTrail,
        });
        this.stateStore.closeBuffer(buffer._id, 'CLOSED', finalReason);
        buffer.state = 'CLOSED';
        buffer.reason = finalReason;
        buffer.policyTrail = finalPolicyTrail;
        buffer.completedAt = Date.now();
        this.queuePersistBuffer(buffer);
        logger.debug(
            `${buffer.bufferKey} 已生成实盘买入批次 requestedUsdc=${formatAmount(finalRequestedUsdc)}`
        );
    }

    private async flushDueBuyBuffers() {
        const dueBuffers = this.stateStore.listDueBuffers();
        for (const buffer of dueBuffers) {
            await this.flushBuyBuffer(buffer);
        }
    }

    private async bufferBuyIntent(params: {
        trade: UserActivityInterface;
        requestedUsdc: number;
        sourcePrice: number;
        reason: string;
        policyTrail?: ExecutionPolicyTrailEntry[];
        allowBootstrapFlush?: boolean;
    }) {
        const {
            trade,
            requestedUsdc,
            sourcePrice,
            reason,
            policyTrail = [],
            allowBootstrapFlush = false,
        } = params;
        const normalizedRequestedUsdc = Math.max(toSafeNumber(requestedUsdc), 0);
        if (normalizedRequestedUsdc <= 0) {
            return;
        }

        let openBuffer = this.stateStore.getOpenBuffer(buildLiveBuyBufferKey(trade));
        if (openBuffer && shouldFlushBufferBeforeAppendingTrade(openBuffer, trade)) {
            await this.flushBuyBuffer(openBuffer, {
                extraPolicyTrail: [
                    buildPolicyTrailEntry(
                        LIVE_BUY_BUFFER_POLICY_ID,
                        'DEFER',
                        `检测到新的同资产买单，上一段累计窗口已超过 ${BUY_INTENT_BUFFER_MAX_MS}ms`
                    ),
                ],
            });
            openBuffer = null;
        }

        const nextRequestedUsdc =
            Math.max(toSafeNumber(openBuffer?.requestedUsdc), 0) + normalizedRequestedUsdc;
        const flushImmediately =
            nextRequestedUsdc >= MIN_MARKET_BUY_USDC ||
            (allowBootstrapFlush && nextRequestedUsdc >= BUY_MIN_TOP_UP_TRIGGER_USDC);
        const nextFlushAt = flushImmediately ? Date.now() : Date.now() + BUY_INTENT_BUFFER_MAX_MS;
        const nextReason = mergeReasons(openBuffer?.reason, reason);
        const nextPolicyTrail = mergePolicyTrail(openBuffer?.policyTrail, policyTrail, [
            buildPolicyTrailEntry(
                LIVE_BUY_BUFFER_POLICY_ID,
                'DEFER',
                flushImmediately
                    ? nextRequestedUsdc >= MIN_MARKET_BUY_USDC
                        ? `累计买单已达到 ${nextRequestedUsdc.toFixed(4)} USDC，准备生成批次`
                        : `累计买单已达到 ${nextRequestedUsdc.toFixed(4)} USDC，准备按最小门槛补齐后生成批次`
                    : `累计买单 ${nextRequestedUsdc.toFixed(4)} USDC，继续等待凑满 ${MIN_MARKET_BUY_USDC} USDC`
            ),
        ]);

        const nextBuffer = this.stateStore.mergeIntoOpenBuffer(openBuffer, {
            trade,
            bufferKey: buildLiveBuyBufferKey(trade),
            requestedUsdc: normalizedRequestedUsdc,
            sourcePrice: Math.max(toSafeNumber(sourcePrice), toSafeNumber(trade.price), 0),
            flushAfter: nextFlushAt,
            reason: nextReason,
            policyTrail: nextPolicyTrail,
        });
        this.queuePersistBuffer(nextBuffer);
        const tradeState = this.stateStore.getTradeState(trade);
        if (tradeState) {
            tradeState.status = 'BUFFERED';
            tradeState.bufferId = nextBuffer._id;
            tradeState.lastError = nextReason;
            tradeState.policyTrail = nextPolicyTrail;
            this.queuePersistSingleTradeState(tradeState);
        }
    }

    private async processPendingTrades(pendingTrades: LiveTradeRuntimeState[]) {
        for (const state of pendingTrades) {
            const trade = state.trade;
            try {
                const resolution = await this.loadMarketResolution(trade);
                if (resolution && !isTradablePolymarketMarket(resolution)) {
                    const reason = isResolvedPolymarketMarket(resolution)
                        ? `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，已跳过真实执行并交由结算回收器处理`
                        : '市场已停止接单，已跳过真实执行并等待结算回收';
                    await this.cancelOpenBuyBuffersForAsset(trade);
                    await this.cancelReadyBuyBatchesForAsset(trade);
                    this.finalizeTradeState(state, 'SKIPPED', reason);
                    continue;
                }

                const validation = validateTradeForExecution(trade);
                if (validation.status === 'SKIP') {
                    this.finalizeTradeState(state, 'SKIPPED', validation.reason);
                    continue;
                }

                if (validation.status === 'RETRY') {
                    state.retryCount += 1;
                    if (state.retryCount >= RETRY_LIMIT) {
                        this.finalizeTradeState(state, 'FAILED', validation.reason);
                    } else {
                        state.lastError = validation.reason;
                        this.stateStore.markTradePending(trade, validation.reason);
                        this.queuePersistSingleTradeState(state);
                        logger.warn(`${formatTradeRef(trade)} 待重试 reason=${validation.reason}`);
                    }
                    continue;
                }

                const normalizedSide = String(trade.side || '').toUpperCase();
                if (normalizedSide === 'BUY') {
                    const context = await this.refreshTradingContext();
                    if (context.skipReason) {
                        this.stateStore.markTradePending(trade, context.skipReason);
                        state.lastError = context.skipReason;
                        this.queuePersistSingleTradeState(state);
                        logger.warn(
                            `${formatTradeRef(trade)} 暂缓入批 reason=${context.skipReason}`
                        );
                        continue;
                    }

                    if (context.availableBalance === null) {
                        const reason = '代理钱包可用余额接口不可用';
                        this.stateStore.markTradePending(trade, reason);
                        state.lastError = reason;
                        this.queuePersistSingleTradeState(state);
                        logger.warn(`${formatTradeRef(trade)} 暂缓入批 reason=${reason}`);
                        continue;
                    }

                    const openBuffer = this.stateStore.getOpenBuffer(buildLiveBuyBufferKey(trade));
                    if (openBuffer && shouldFlushBufferBeforeAppendingTrade(openBuffer, trade)) {
                        await this.flushBuyBuffer(openBuffer, {
                            extraPolicyTrail: [
                                buildPolicyTrailEntry(
                                    LIVE_BUY_BUFFER_POLICY_ID,
                                    'DEFER',
                                    `检测到新的同资产买单，上一段累计窗口已超过 ${BUY_INTENT_BUFFER_MAX_MS}ms`
                                ),
                            ],
                        });
                    }
                    const latestBuffer = this.stateStore.getOpenBuffer(
                        buildLiveBuyBufferKey(trade)
                    );
                    const activeBuyBatch = this.stateStore.getActiveBuyBatch(trade);
                    const existingPosition = findPositionForTrade(context.positions, trade);
                    const hasLocalExposure =
                        Math.max(toSafeNumber(existingPosition?.size), 0) > EPSILON;
                    const hasPendingBuyExposure = latestBuffer !== null || activeBuyBatch !== null;
                    const reservedBuyExposureUsdc = this.stateStore.reservedBuyExposureUsdc();
                    const availableBalance = Math.max(
                        toSafeNumber(context.availableBalance) - reservedBuyExposureUsdc,
                        0
                    );
                    const bootstrapBudgetRemainingUsdc = buildBootstrapBudgetRemainingUsdc(
                        context,
                        this.stateStore
                    );
                    const evaluation = evaluateDirectBuyIntent({
                        trade,
                        availableBalance,
                        hasLocalExposure,
                        hasPendingBuyExposure,
                        sourcePositionBeforeTradeSize: trade.sourcePositionSizeBeforeTrade,
                        allowLocalFirstEntryTicket: true,
                        bootstrapBudgetRemainingUsdc,
                    });
                    const shouldBufferTrade =
                        Math.max(toSafeNumber(evaluation.requestedUsdc), 0) > 0 &&
                        (latestBuffer !== null ||
                            (evaluation.status === 'SKIP' &&
                                evaluation.requestedUsdc < MIN_MARKET_BUY_USDC));

                    if (shouldBufferTrade) {
                        await this.bufferBuyIntent({
                            trade,
                            requestedUsdc: evaluation.requestedUsdc,
                            sourcePrice: evaluation.sourcePrice,
                            reason: evaluation.reason,
                            policyTrail: evaluation.policyTrail,
                            allowBootstrapFlush:
                                !hasLocalExposure &&
                                activeBuyBatch === null &&
                                bootstrapBudgetRemainingUsdc + EPSILON >= MIN_MARKET_BUY_USDC,
                        });
                        logger.debug(
                            `${formatTradeRef(trade)} 已写入实盘买单缓冲 requestedUsdc=${formatAmount(
                                evaluation.requestedUsdc
                            )}` + (evaluation.reason ? ` reason=${evaluation.reason}` : '')
                        );
                        continue;
                    }

                    if (evaluation.status === 'SKIP') {
                        this.finalizeTradeState(
                            state,
                            'SKIPPED',
                            evaluation.reason,
                            evaluation.policyTrail
                        );
                        continue;
                    }

                    state.status = 'BATCHED';
                    state.lastError = evaluation.reason;
                    state.policyTrail = evaluation.policyTrail;
                    await this.createBatch({
                        trades: [trade],
                        condition: 'buy',
                        requestedUsdc: evaluation.requestedUsdc,
                        sourcePrice: evaluation.sourcePrice,
                        reason: evaluation.reason,
                        policyTrail: evaluation.policyTrail,
                    });
                    continue;
                }

                await this.cancelOpenBuyBuffersForAsset(trade);
                await this.cancelReadyBuyBatchesForAsset(trade);
                await this.createBatch({
                    trades: [trade],
                });
            } catch (error) {
                state.retryCount += 1;
                const reason = '交易入批流程发生未预期异常';
                if (state.retryCount >= RETRY_LIMIT) {
                    this.finalizeTradeState(state, 'FAILED', reason);
                } else {
                    this.stateStore.markTradePending(trade, reason);
                    state.lastError = reason;
                    this.queuePersistSingleTradeState(state);
                    logger.error(`${formatTradeRef(trade)} 入批异常`, error);
                }
            }
        }
    }

    private executeReadyBatches() {
        const readyBatches = this.stateStore.listReadyBatches();
        for (const batch of readyBatches) {
            const batchId = String(batch._id);
            if (this.executingBatchIds.has(batchId)) {
                continue;
            }

            this.executingBatchIds.add(batchId);
            void this.executeBatch(batch).finally(() => {
                this.executingBatchIds.delete(batchId);
            });
        }
    }

    private async executeBatch(batch: CopyExecutionBatchInterface) {
        const claimedBatch = this.stateStore.markBatchProcessing(batch._id);
        if (!claimedBatch) {
            return;
        }

        try {
            const trades = this.stateStore.getTradesByIds(claimedBatch.sourceTradeIds);
            const latestTrade = sortTradesAsc(trades).slice(-1)[0];
            if (!latestTrade) {
                this.finalizeBatch(claimedBatch, 'FAILED', '批次缺少关联源交易');
                return;
            }

            const context = await this.refreshTradingContext(true);
            if (context.skipReason) {
                this.stateStore.markBatchReady(claimedBatch._id, context.skipReason);
                claimedBatch.reason = context.skipReason;
                this.queuePersistBatch(claimedBatch);
                return;
            }

            if (context.availableBalance === null) {
                const reason = '代理钱包可用余额接口不可用';
                this.stateStore.markBatchReady(claimedBatch._id, reason);
                claimedBatch.reason = reason;
                this.queuePersistBatch(claimedBatch);
                return;
            }

            const myPosition = findPositionForTrade(context.positions, latestTrade);
            const sourcePositionAfterTrade = {
                size: latestTrade.sourcePositionSizeAfterTrade,
            };
            const condition =
                claimedBatch.condition ||
                resolveTradeCondition(latestTrade.side, myPosition, sourcePositionAfterTrade);
            const result = await postOrder(
                this.clobClient,
                this.marketStream,
                condition,
                myPosition,
                sourcePositionAfterTrade,
                latestTrade,
                context.availableBalance,
                claimedBatch.requestedUsdc > 0 || claimedBatch.requestedSize > 0
                    ? {
                          requestedUsdc:
                              claimedBatch.requestedUsdc > 0
                                  ? claimedBatch.requestedUsdc
                                  : undefined,
                          requestedSize:
                              claimedBatch.requestedSize > 0
                                  ? claimedBatch.requestedSize
                                  : undefined,
                          sourcePrice:
                              claimedBatch.sourcePrice > 0 ? claimedBatch.sourcePrice : undefined,
                          note: claimedBatch.reason,
                      }
                    : undefined
            );

            if (result.status === 'RETRYABLE_ERROR') {
                const noLiquidityRetry = isNoLiquidityReason(result.reason);
                const nextRetryCount =
                    toSafeNumber(claimedBatch.retryCount) + (noLiquidityRetry ? 1 : 0);
                if (noLiquidityRetry && nextRetryCount >= RETRY_LIMIT) {
                    const reason = `连续 ${RETRY_LIMIT} 次空盘口/流动性不足，已放弃本批次`;
                    claimedBatch.policyTrail = mergePolicyTrail(claimedBatch.policyTrail, [
                        buildPolicyTrailEntry('no-liquidity-timeout', 'SKIP', reason),
                    ]);
                    claimedBatch.reason = reason;
                    this.finalizeBatch(claimedBatch, 'SKIPPED', reason);
                    return;
                }

                this.stateStore.markBatchReady(claimedBatch._id, result.reason, noLiquidityRetry);
                claimedBatch.reason = result.reason;
                if (noLiquidityRetry) {
                    claimedBatch.retryCount = nextRetryCount;
                }
                this.queuePersistBatch(claimedBatch);
                logger.warn(`${formatBatchRef(claimedBatch)} 待重试 reason=${result.reason}`);
                return;
            }

            if (result.orderIds.length > 0 || result.transactionHashes.length > 0) {
                claimedBatch.reason = result.reason;
                claimedBatch.orderIds = result.orderIds;
                claimedBatch.transactionHashes = result.transactionHashes;
                claimedBatch.submissionStatus = result.submissionStatus || 'SUBMITTED';
                claimedBatch.submittedAt = Date.now();
                claimedBatch.claimedAt = Date.now();
                this.stateStore.markBatchSubmitted(claimedBatch._id, claimedBatch);
                this.queuePersistBatch(claimedBatch);
                this.queuePersistTradesByBatch(claimedBatch, 'SUBMITTED');
                this.stateStore.markTradesByBatch(claimedBatch, {
                    status: 'SUBMITTED',
                    lastError: result.reason,
                    orderIds: result.orderIds,
                    transactionHashes: result.transactionHashes,
                    submittedAt: claimedBatch.submittedAt,
                    batchId: claimedBatch._id,
                    bufferId: claimedBatch.bufferId,
                    policyTrail: claimedBatch.policyTrail || [],
                });
                logger.debug(
                    `${formatBatchRef(claimedBatch)} 已提交 orderIds=${result.orderIds.length} txHashes=${result.transactionHashes.length}`
                );
                return;
            }

            this.finalizeBatch(
                claimedBatch,
                result.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
                result.reason
            );
        } catch (error) {
            const reason = '批次执行链路发生未预期异常';
            this.stateStore.markBatchReady(claimedBatch._id, reason);
            claimedBatch.reason = reason;
            this.queuePersistBatch(claimedBatch);
            logger.error(`${formatBatchRef(claimedBatch)} 执行异常`, error);
        }
    }

    private syncSubmittedBatches() {
        const submittedBatches = this.stateStore.listSubmittedBatches();
        for (const batch of submittedBatches) {
            const batchId = String(batch._id);
            if (this.confirmingBatchIds.has(batchId)) {
                continue;
            }

            this.confirmingBatchIds.add(batchId);
            void this.confirmBatch(batch).finally(() => {
                this.confirmingBatchIds.delete(batchId);
            });
        }
    }

    private async confirmBatch(batch: CopyExecutionBatchInterface) {
        try {
            const trades = this.stateStore.getTradesByIds(batch.sourceTradeIds);
            const latestTrade = sortTradesAsc(trades).slice(-1)[0];
            if (!latestTrade) {
                this.finalizeBatch(batch, 'FAILED', '批次缺少关联源交易');
                return;
            }

            const orderIds = (batch.orderIds || []).filter(Boolean);
            let normalizedConfirmation;
            if (this.userStream && orderIds.length > 0) {
                normalizedConfirmation = await this.userStream.waitForOrders({
                    conditionId: latestTrade.conditionId,
                    orderIds,
                    onStatus: async (update: UserChannelStatusUpdate) => {
                        batch.reason = update.reason;
                        if (update.confirmedAt) {
                            batch.confirmedAt = update.confirmedAt;
                        }
                        if (update.status && update.status !== 'SUBMITTED') {
                            batch.submissionStatus = update.status;
                        }
                        this.queuePersistBatchProgress(batch, update);
                    },
                });
            } else {
                const chainConfirmation = await confirmTransactionHashes(
                    batch.transactionHashes || []
                );
                const update: UserChannelStatusUpdate = {
                    status:
                        chainConfirmation.status === 'CONFIRMED'
                            ? 'CONFIRMED'
                            : chainConfirmation.status === 'FAILED'
                              ? 'FAILED'
                              : 'SUBMITTED',
                    reason: chainConfirmation.reason,
                    confirmedAt: chainConfirmation.confirmedAt,
                };
                this.queuePersistBatchProgress(batch, update);
                normalizedConfirmation = {
                    confirmationStatus: chainConfirmation.status,
                    ...update,
                };
            }

            if (normalizedConfirmation.confirmationStatus === 'PENDING') {
                if (
                    normalizedConfirmation.status &&
                    normalizedConfirmation.status !== 'SUBMITTED'
                ) {
                    batch.submissionStatus = normalizedConfirmation.status;
                }
                batch.reason = mergeReasons(batch.reason, normalizedConfirmation.reason);
                this.queuePersistBatch(batch);
                logger.warn(
                    `${formatBatchRef(batch)} 等待确认，稍后继续监听 reason=${batch.reason}`
                );
                return;
            }

            if (normalizedConfirmation.confirmationStatus === 'FAILED') {
                this.finalizeBatch(
                    batch,
                    'FAILED',
                    mergeReasons(batch.reason, normalizedConfirmation.reason)
                );
                return;
            }

            const finalStatus =
                normalizedConfirmation.status === 'FAILED' || batch.submissionStatus === 'FAILED'
                    ? 'FAILED'
                    : 'CONFIRMED';
            this.finalizeBatch(
                batch,
                finalStatus,
                normalizedConfirmation.reason,
                normalizedConfirmation.confirmedAt
            );
        } catch (error) {
            logger.error(`${formatBatchRef(batch)} 确认异常`, error);
        }
    }
}

export interface LiveTradeExecutorHandle {
    run: () => Promise<void>;
    ingestSourceTrades: (trades: UserActivityInterface[]) => void;
}

const tradeExecutor = (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null
): LiveTradeExecutorHandle => {
    const runtime = new LiveTradeExecutorRuntime(clobClient, marketStream, userStream);
    return {
        run: () => runtime.run(),
        ingestSourceTrades: runtime.ingestSourceTrades,
    };
};

export default tradeExecutor;
