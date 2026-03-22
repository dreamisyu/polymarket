import mongoose from 'mongoose';
import { ClobClient } from '@polymarket/clob-client';
import {
    CopyExecutionBatchInterface,
    CopyIntentBufferInterface,
    ExecutionKind,
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
import {
    buildConditionOutcomeKey,
    computeConditionMergeableSize,
} from '../utils/conditionPositionMath';
import {
    evaluateBufferedSignalBuy,
    evaluateDirectBuyIntent,
    evaluateSignalBuyTrade,
    getSignalTierLabel,
    getTradeSourceUsdc,
    sortTradesAsc,
} from '../utils/copyIntentPlanning';
import { buildPolicyTrailEntry, hasPolicyId, mergePolicyTrail } from '../utils/executionPolicy';
import {
    resolveExecutionIntent,
    resolveTradeAction,
    validateExecutableSnapshot,
} from '../utils/executionSemantics';
import fetchData from '../utils/fetchData';
import getTradingGuardState from '../utils/getTradingGuardState';
import createLogger from '../utils/logger';
import postConditionMerge from '../utils/postConditionMerge';
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
const SIGNAL_BUFFER_MS = ENV.SIGNAL_BUFFER_MS;
const BUY_MIN_TOP_UP_TRIGGER_USDC = ENV.BUY_MIN_TOP_UP_TRIGGER_USDC;
const BUY_BOOTSTRAP_MAX_ACTIVE_RATIO = ENV.BUY_BOOTSTRAP_MAX_ACTIVE_RATIO;
const BUY_SIZING_MODE = ENV.BUY_SIZING_MODE;
const FOLLOW_MAX_OPEN_POSITIONS = ENV.FOLLOW_MAX_OPEN_POSITIONS;
const FOLLOW_MAX_ACTIVE_EXPOSURE_USDC = ENV.FOLLOW_MAX_ACTIVE_EXPOSURE_USDC;
const FOLLOW_MAX_TICKETS_PER_CONDITION = ENV.FOLLOW_MAX_TICKETS_PER_CONDITION;
const LOOP_INTERVAL_MS = ENV.LIVE_EXECUTOR_LOOP_INTERVAL_MS;
const CONTEXT_TTL_MS = ENV.LIVE_STATE_REFRESH_MS;
const LIVE_MAX_STALE_SNAPSHOT_MS = ENV.LIVE_MAX_STALE_SNAPSHOT_MS;
const LIVE_CONFIRM_TIMEOUT_MS = ENV.LIVE_CONFIRM_TIMEOUT_MS;
const LIVE_RECONCILE_AFTER_TIMEOUT_MS = ENV.LIVE_RECONCILE_AFTER_TIMEOUT_MS;
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
const SIGNAL_BUY_BUFFER_POLICY_ID = 'signal-buy-intent-buffer';
const SIGNAL_SECOND_TICKET_POLICY_ID = 'signal-second-ticket';
const SIGNAL_MAX_TICKETS_POLICY_ID = 'signal-max-tickets';
const MERGE_EXECUTION_POLICY_ID = 'live-condition-merge';
const LIVE_RECOVERY_POLICY_ID = 'live-recovery-drop';
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

interface MergeExecutionPlan {
    status: 'READY' | 'SKIPPED' | 'RETRY';
    reason: string;
    requestedSize: number;
    sourceMergeRatio: number;
    localMergeableBefore: number;
    partition: bigint[];
    policyTrail: ExecutionPolicyTrailEntry[];
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
    `tx=${trade.transactionHash} side=${resolveTradeAction(trade)} asset=${trade.asset}`;

const formatBatchRef = (
    batch: Pick<CopyExecutionBatchInterface, 'asset' | 'condition' | 'sourceTradeCount'>
) => `condition=${batch.condition} asset=${batch.asset} trades=${batch.sourceTradeCount}`;

const formatTerminalStatus = (status: 'CONFIRMED' | 'SKIPPED' | 'FAILED') =>
    status === 'CONFIRMED' ? '已确认' : status === 'SKIPPED' ? '已跳过' : '已失败';

const buildLiveBuyBufferKey = (trade: Pick<UserActivityInterface, 'asset' | 'conditionId'>) =>
    `buy:${trade.conditionId}:${trade.asset}`;

const buildSignalMaxTicketsReason = () =>
    `已达到同 condition/outcome 最大跟单次数 ${FOLLOW_MAX_TICKETS_PER_CONDITION}`;

const shouldFlushBufferBeforeAppendingTrade = (
    buffer: Pick<CopyIntentBufferInterface, 'sourceEndedAt' | 'bufferWindowMs'>,
    trade: Pick<UserActivityInterface, 'timestamp'>
) =>
    toSafeNumber(buffer.sourceEndedAt) > 0 &&
    trade.timestamp > toSafeNumber(buffer.sourceEndedAt) &&
    trade.timestamp - toSafeNumber(buffer.sourceEndedAt) >
        Math.max(toSafeNumber(buffer.bufferWindowMs), BUY_INTENT_BUFFER_MAX_MS);

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

const buildRecoveryTradeTimestamp = (
    trade: Pick<UserActivityInterface, 'sourceSnapshotCapturedAt' | 'timestamp'>
) => Math.max(toSafeNumber(trade.sourceSnapshotCapturedAt), toSafeNumber(trade.timestamp), 0);

const buildRecoveryPendingTradeReason = (ageMs: number) =>
    `启动恢复时源账户快照已陈旧 ${ageMs}ms，超过 live 允许上限 ${LIVE_MAX_STALE_SNAPSHOT_MS}ms，已丢弃旧待执行交易`;

const buildRecoveryBufferReason = (ageMs: number, recoveryWindowMs: number) =>
    `启动恢复时旧缓冲已空转 ${ageMs}ms，超过恢复窗口 ${recoveryWindowMs}ms，已放弃该缓冲`;

const buildRecoveryBatchReason = (ageMs: number) =>
    `启动恢复时旧批次已等待 ${ageMs}ms，超过 live 快照时效 ${LIVE_MAX_STALE_SNAPSHOT_MS}ms，已放弃未提交批次`;

const buildBootstrapBudgetRemainingUsdc = (context: TradingContext, stateStore: LiveStateStore) => {
    const activeBootstrapExposureUsdc = stateStore.activeBootstrapExposureUsdc();
    return Math.max(
        context.totalEquity * BUY_BOOTSTRAP_MAX_ACTIVE_RATIO - activeBootstrapExposureUsdc,
        0
    );
};

const countOpenLivePositions = (positions: UserPositionInterface[]) =>
    positions.filter((position) => Math.max(toSafeNumber(position.size), 0) > EPSILON).length;

const buildLiveActiveExposureUsdc = (context: TradingContext, reservedBuyExposureUsdc: number) =>
    Math.max(context.totalEquity - Math.max(toSafeNumber(context.availableBalance), 0), 0) +
    Math.max(toSafeNumber(reservedBuyExposureUsdc), 0);

const validateTradeForExecution = (trade: UserActivityInterface) => {
    const snapshotValidation = validateExecutableSnapshot(trade, {
        mode: 'live',
        maxLiveStaleSnapshotMs: LIVE_MAX_STALE_SNAPSHOT_MS,
    });
    if (snapshotValidation.status !== 'OK') {
        return snapshotValidation;
    }

    if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
        return {
            status: 'RETRY' as const,
            reason: '缺少源账户持仓快照',
        };
    }

    if (
        resolveTradeAction(trade) === 'BUY' &&
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
            (trade) => resolveExecutionIntent(trade, 'live') === 'EXECUTE'
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

    private queuePersistRecoveredTradeTerminalState(
        trade: UserActivityInterface,
        status: 'SKIPPED' | 'FAILED',
        reason: string
    ) {
        const executedAt = Date.now();
        this.queuePersistActivityUpdate([trade._id], {
            bot: true,
            botStatus: status,
            botClaimedAt: 0,
            botExecutedAt: executedAt,
            botLastError: reason,
            botPolicyTrail: [
                buildPolicyTrailEntry(
                    LIVE_RECOVERY_POLICY_ID,
                    status === 'SKIPPED' ? 'SKIP' : 'RETRY',
                    reason
                ),
            ],
        });
    }

    private shouldRecoverPendingTrade(
        trade: UserActivityInterface,
        referencedTradeIds: Set<string>,
        now = Date.now()
    ) {
        if (referencedTradeIds.has(String(trade._id))) {
            return {
                recover: true,
                reason: '',
            };
        }

        const snapshotTimestamp = buildRecoveryTradeTimestamp(trade);
        if (snapshotTimestamp <= 0) {
            return {
                recover: false,
                reason: '启动恢复时缺少源账户快照时间，已丢弃旧待执行交易',
            };
        }

        const snapshotAgeMs = now - snapshotTimestamp;
        if (snapshotAgeMs > LIVE_MAX_STALE_SNAPSHOT_MS) {
            return {
                recover: false,
                reason: buildRecoveryPendingTradeReason(snapshotAgeMs),
            };
        }

        return {
            recover: true,
            reason: '',
        };
    }

    private shouldRecoverBuffer(buffer: CopyIntentBufferInterface, now = Date.now()) {
        const lastSourceAt = Math.max(
            toSafeNumber(buffer.sourceEndedAt),
            toSafeNumber(buffer.sourceStartedAt),
            0
        );
        const recoveryWindowMs = Math.max(
            toSafeNumber(buffer.bufferWindowMs),
            LIVE_MAX_STALE_SNAPSHOT_MS
        );
        if (lastSourceAt <= 0) {
            return {
                recover: false,
                reason: '启动恢复时旧缓冲缺少时间戳，已放弃该缓冲',
            };
        }

        const ageMs = now - lastSourceAt;
        if (ageMs > recoveryWindowMs) {
            return {
                recover: false,
                reason: buildRecoveryBufferReason(ageMs, recoveryWindowMs),
            };
        }

        return {
            recover: true,
            reason: '',
        };
    }

    private shouldRecoverBatch(batch: CopyExecutionBatchInterface, now = Date.now()) {
        if (['SUBMITTED', 'PENDING_CONFIRMATION', 'TIMEOUT'].includes(batch.status)) {
            return {
                recover: true,
                reason: '',
            };
        }

        const lastSourceAt = Math.max(
            toSafeNumber(batch.sourceEndedAt),
            toSafeNumber(batch.sourceStartedAt),
            0
        );
        if (lastSourceAt <= 0) {
            return {
                recover: false,
                reason: '启动恢复时旧批次缺少时间戳，已放弃未提交批次',
            };
        }

        const ageMs = now - lastSourceAt;
        if (ageMs > LIVE_MAX_STALE_SNAPSHOT_MS) {
            return {
                recover: false,
                reason: buildRecoveryBatchReason(ageMs),
            };
        }

        return {
            recover: true,
            reason: '',
        };
    }

    private async hydrateRecoveryState() {
        const [recoverableTrades, openBuffers, activeBatches] = await Promise.all([
            UserActivity.find({
                $and: [
                    { type: { $in: ['TRADE', 'MERGE'] } },
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
                                        'PENDING_CONFIRMATION',
                                        'TIMEOUT',
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
                status: {
                    $in: ['READY', 'PROCESSING', 'SUBMITTED', 'PENDING_CONFIRMATION', 'TIMEOUT'],
                },
            })
                .sort({ sourceStartedAt: 1, createdAt: 1 })
                .exec() as Promise<CopyExecutionBatchInterface[]>,
        ]);

        const now = Date.now();
        const recoveredBuffers: CopyIntentBufferInterface[] = [];
        const droppedBuffers: Array<{ buffer: CopyIntentBufferInterface; reason: string }> = [];
        for (const buffer of openBuffers) {
            const recovery = this.shouldRecoverBuffer(buffer, now);
            if (recovery.recover) {
                recoveredBuffers.push(buffer);
                continue;
            }

            droppedBuffers.push({ buffer, reason: recovery.reason });
        }

        const recoveredBatches: CopyExecutionBatchInterface[] = [];
        const droppedBatches: Array<{ batch: CopyExecutionBatchInterface; reason: string }> = [];
        for (const batch of activeBatches) {
            const recovery = this.shouldRecoverBatch(batch, now);
            if (recovery.recover) {
                recoveredBatches.push(batch);
                continue;
            }

            droppedBatches.push({ batch, reason: recovery.reason });
        }

        const referencedTradeIds = new Set<string>(
            [
                ...recoveredBuffers.flatMap((buffer) => buffer.sourceTradeIds),
                ...recoveredBatches.flatMap((batch) => batch.sourceTradeIds),
            ].map((tradeId) => String(tradeId))
        );
        const recoveredTrades: UserActivityInterface[] = [];
        const droppedTrades: Array<{ trade: UserActivityInterface; reason: string }> = [];
        for (const trade of recoverableTrades) {
            const recovery = this.shouldRecoverPendingTrade(trade, referencedTradeIds, now);
            if (recovery.recover) {
                recoveredTrades.push(trade);
                continue;
            }

            droppedTrades.push({ trade, reason: recovery.reason });
        }

        const terminalRecoveredTradeIds = new Set<string>();
        const queueRecoveredTradeSkip = (trade: UserActivityInterface, reason: string) => {
            const tradeId = String(trade._id);
            if (terminalRecoveredTradeIds.has(tradeId)) {
                return;
            }

            terminalRecoveredTradeIds.add(tradeId);
            this.queuePersistRecoveredTradeTerminalState(trade, 'SKIPPED', reason);
        };

        this.stateStore.ingestTrades(recoveredTrades);
        for (const buffer of recoveredBuffers) {
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

        for (const batch of recoveredBatches) {
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

        for (const { buffer, reason } of droppedBuffers) {
            this.persistenceQueue.enqueue(`recovery-buffer:${String(buffer._id)}`, async () => {
                await CopyIntentBuffer.updateOne(
                    { _id: buffer._id },
                    {
                        $set: {
                            state: 'SKIPPED',
                            claimedAt: 0,
                            completedAt: now,
                            reason,
                            policyTrail: mergePolicyTrail(buffer.policyTrail, [
                                buildPolicyTrailEntry(LIVE_RECOVERY_POLICY_ID, 'SKIP', reason),
                            ]),
                        },
                    }
                );
            });
            for (const tradeId of buffer.sourceTradeIds) {
                const trade = recoverableTrades.find(
                    (item) => String(item._id) === String(tradeId)
                );
                if (trade) {
                    queueRecoveredTradeSkip(trade, reason);
                }
            }
        }

        for (const { batch, reason } of droppedBatches) {
            this.persistenceQueue.enqueue(`recovery-batch:${String(batch._id)}`, async () => {
                await CopyExecutionBatch.updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            status: 'SKIPPED',
                            claimedAt: 0,
                            completedAt: now,
                            reason,
                            policyTrail: mergePolicyTrail(batch.policyTrail, [
                                buildPolicyTrailEntry(LIVE_RECOVERY_POLICY_ID, 'SKIP', reason),
                            ]),
                        },
                    }
                );
            });
            for (const tradeId of batch.sourceTradeIds) {
                const trade = recoverableTrades.find(
                    (item) => String(item._id) === String(tradeId)
                );
                if (trade) {
                    queueRecoveredTradeSkip(trade, reason);
                }
            }
        }

        for (const { trade, reason } of droppedTrades) {
            queueRecoveredTradeSkip(trade, reason);
        }

        if (
            recoveredTrades.length > 0 ||
            recoveredBuffers.length > 0 ||
            recoveredBatches.length > 0
        ) {
            logger.warn(
                `已恢复 live 状态 trades=${recoveredTrades.length} buffers=${recoveredBuffers.length} batches=${recoveredBatches.length}`
            );
        }

        if (droppedTrades.length > 0 || droppedBuffers.length > 0 || droppedBatches.length > 0) {
            logger.warn(
                `启动恢复阶段已丢弃旧状态 trades=${droppedTrades.length} buffers=${droppedBuffers.length} batches=${droppedBatches.length}`
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

    private buildConditionPartition(
        trade: Pick<UserActivityInterface, 'conditionId'>,
        positions: UserPositionInterface[]
    ) {
        return positions
            .filter(
                (position) =>
                    position.conditionId === trade.conditionId &&
                    Math.max(toSafeNumber(position.size), 0) > EPSILON &&
                    Number.isInteger(position.outcomeIndex) &&
                    position.outcomeIndex >= 0
            )
            .map((position) => 1n << BigInt(position.outcomeIndex))
            .filter((value, index, values) => values.findIndex((item) => item === value) === index)
            .sort((left, right) => Number(left - right));
    }

    private computeLocalConditionMergeableSize(
        trade: Pick<UserActivityInterface, 'conditionId' | 'asset' | 'outcomeIndex' | 'outcome'>,
        positions: UserPositionInterface[]
    ) {
        const outcomeKeys = [
            ...new Set(
                positions
                    .filter((position) => position.conditionId === trade.conditionId)
                    .map((position) => buildConditionOutcomeKey(position))
                    .filter(Boolean)
            ),
        ];
        const sizeByOutcomeKey = new Map<string, number>();
        for (const position of positions) {
            if (position.conditionId !== trade.conditionId) {
                continue;
            }

            const outcomeKey = buildConditionOutcomeKey(position);
            if (!outcomeKey) {
                continue;
            }

            sizeByOutcomeKey.set(outcomeKey, Math.max(toSafeNumber(position.size), 0));
        }

        return computeConditionMergeableSize(outcomeKeys, sizeByOutcomeKey);
    }

    private buildMergeExecutionPlan(
        trade: UserActivityInterface,
        positions: UserPositionInterface[]
    ): MergeExecutionPlan {
        const sourceMergeRequestedSize = Math.max(
            toSafeNumber(trade.size),
            toSafeNumber(trade.usdcSize)
        );
        const sourceMergeableBefore = Math.max(
            toSafeNumber(
                trade.sourceConditionMergeableSizeBeforeTrade,
                toSafeNumber(trade.sourceConditionMergeableSizeAfterTrade) +
                    sourceMergeRequestedSize
            ),
            0
        );
        const localMergeableBefore = this.computeLocalConditionMergeableSize(trade, positions);
        const partition = this.buildConditionPartition(trade, positions);

        if (sourceMergeRequestedSize <= EPSILON) {
            return {
                status: 'SKIPPED',
                reason: '源 MERGE 数量无效，已跳过真实 condition merge',
                requestedSize: 0,
                sourceMergeRatio: 0,
                localMergeableBefore,
                partition,
                policyTrail: [],
            };
        }

        if (sourceMergeableBefore <= EPSILON) {
            return {
                status: 'RETRY',
                reason: '缺少源账户 condition mergeable 快照，暂缓真实 condition merge',
                requestedSize: 0,
                sourceMergeRatio: 0,
                localMergeableBefore,
                partition,
                policyTrail: [],
            };
        }

        if (localMergeableBefore <= EPSILON) {
            return {
                status: 'SKIPPED',
                reason: '本地无可 merge 的 complete set',
                requestedSize: 0,
                sourceMergeRatio: 0,
                localMergeableBefore,
                partition,
                policyTrail: [],
            };
        }

        if (partition.length < 2) {
            return {
                status: 'SKIPPED',
                reason: '本地缺少完整 outcome partition，无法执行链上 merge',
                requestedSize: 0,
                sourceMergeRatio: 0,
                localMergeableBefore,
                partition,
                policyTrail: [],
            };
        }

        const sourceMergeRatio = Math.min(sourceMergeRequestedSize / sourceMergeableBefore, 1);
        const requestedSize = Math.max(localMergeableBefore * sourceMergeRatio, 0);
        if (requestedSize <= EPSILON) {
            return {
                status: 'SKIPPED',
                reason: '按比例换算后的本地 merge 数量为 0',
                requestedSize: 0,
                sourceMergeRatio,
                localMergeableBefore,
                partition,
                policyTrail: [],
            };
        }

        const reason = `根据源账户 MERGE 比例 ${(sourceMergeRatio * 100).toFixed(2)}% 执行链上 condition merge`;
        return {
            status: 'READY',
            reason,
            requestedSize,
            sourceMergeRatio,
            localMergeableBefore,
            partition,
            policyTrail: [buildPolicyTrailEntry(MERGE_EXECUTION_POLICY_ID, 'ADJUST', reason)],
        };
    }

    private markBatchPendingConfirmation(
        batch: CopyExecutionBatchInterface,
        reason: string,
        submissionStatus?: CopyExecutionBatchInterface['submissionStatus']
    ) {
        const pendingBatch = this.stateStore.markBatchPendingConfirmation(
            batch._id,
            reason,
            submissionStatus
        );
        if (!pendingBatch) {
            return null;
        }

        this.queuePersistBatch(pendingBatch);
        this.queuePersistTradesByBatch(pendingBatch, 'PENDING_CONFIRMATION');
        this.stateStore.markTradesByBatch(pendingBatch, {
            status: 'PENDING_CONFIRMATION',
            lastError: reason,
            submittedAt: pendingBatch.submittedAt,
            batchId: pendingBatch._id,
            policyTrail: pendingBatch.policyTrail || [],
        });
        return pendingBatch;
    }

    private markBatchTimeout(batch: CopyExecutionBatchInterface, reason: string) {
        const timeoutBatch = this.stateStore.markBatchTimeout(batch._id, reason);
        if (!timeoutBatch) {
            return null;
        }

        this.queuePersistBatch(timeoutBatch);
        this.queuePersistTradesByBatch(timeoutBatch, 'TIMEOUT');
        this.stateStore.markTradesByBatch(timeoutBatch, {
            status: 'TIMEOUT',
            lastError: reason,
            submittedAt: timeoutBatch.submittedAt,
            batchId: timeoutBatch._id,
            policyTrail: timeoutBatch.policyTrail || [],
        });
        return timeoutBatch;
    }

    private async reconcileTimedOutBatch(
        batch: CopyExecutionBatchInterface,
        trade: UserActivityInterface
    ) {
        const chainConfirmation = await confirmTransactionHashes(batch.transactionHashes || [], {
            timeoutMs: LIVE_RECONCILE_AFTER_TIMEOUT_MS,
        });
        if (chainConfirmation.status === 'CONFIRMED') {
            batch.lastConfirmationSource = 'reconcile';
            this.finalizeBatch(
                batch,
                'CONFIRMED',
                mergeReasons(batch.reason, '确认超时后通过链上补偿确认完成'),
                chainConfirmation.confirmedAt
            );
            return;
        }

        const context = await this.refreshTradingContext(true);
        const currentPosition = findPositionForTrade(context.positions, trade);
        const currentPositionSize = Math.max(toSafeNumber(currentPosition?.size), 0);
        const beforePositionSize = Math.max(toSafeNumber(batch.localPositionSizeBefore), 0);
        const currentConditionMergeableSize = this.computeLocalConditionMergeableSize(
            trade,
            context.positions
        );
        const beforeConditionMergeableSize = Math.max(
            toSafeNumber(batch.localConditionMergeableSizeBefore),
            0
        );

        if (
            batch.executionKind === 'MERGE' &&
            currentConditionMergeableSize + EPSILON < beforeConditionMergeableSize
        ) {
            batch.lastConfirmationSource = 'reconcile';
            this.finalizeBatch(
                batch,
                'CONFIRMED',
                mergeReasons(batch.reason, '确认超时后通过持仓变化补偿确认 merge 已执行'),
                Date.now()
            );
            return;
        }

        if (batch.condition === 'buy' && currentPositionSize > beforePositionSize + EPSILON) {
            batch.lastConfirmationSource = 'reconcile';
            this.finalizeBatch(
                batch,
                'CONFIRMED',
                mergeReasons(batch.reason, '确认超时后通过持仓变化补偿确认买单已成交'),
                Date.now()
            );
            return;
        }

        if (batch.condition === 'sell' && currentPositionSize + EPSILON < beforePositionSize) {
            batch.lastConfirmationSource = 'reconcile';
            this.finalizeBatch(
                batch,
                'CONFIRMED',
                mergeReasons(batch.reason, '确认超时后通过持仓变化补偿确认卖单已成交'),
                Date.now()
            );
            return;
        }

        this.finalizeBatch(
            batch,
            'FAILED',
            mergeReasons(batch.reason, '确认超时，reconcile 未观测到预期仓位变化')
        );
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
            .filter((batch) => !['SUBMITTED', 'PENDING_CONFIRMATION'].includes(batch.status));
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
        executionKind?: ExecutionKind;
        requestedUsdc?: number;
        requestedSize?: number;
        sourcePrice?: number;
        localPositionSizeBefore?: number;
        localConditionMergeableSizeBefore?: number;
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
            executionKind:
                params.executionKind ||
                (String(latestTrade.type || '').toUpperCase() === 'MERGE' ? 'MERGE' : 'TRADE'),
            condition,
            asset: latestTrade.asset,
            conditionId: latestTrade.conditionId,
            title: latestTrade.title,
            outcome: latestTrade.outcome,
            side: resolveTradeAction(latestTrade),
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
            localPositionSizeBefore: Math.max(toSafeNumber(params.localPositionSizeBefore), 0),
            localConditionMergeableSizeBefore: Math.max(
                toSafeNumber(params.localConditionMergeableSizeBefore),
                0
            ),
            lastConfirmationSource: '',
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
        if (buffer.sizingMode === 'signal_fixed_ticket') {
            await this.flushSignalBuyBuffer(buffer, options);
            return;
        }

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
            executionKind: 'TRADE',
            requestedUsdc: finalRequestedUsdc,
            sourcePrice: Math.max(
                toSafeNumber(buffer.sourcePrice),
                toSafeNumber(latestTrade.price),
                0
            ),
            localPositionSizeBefore: Math.max(toSafeNumber(existingPosition?.size), 0),
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

    private getSignalTicketCountForTrade(
        trade: Pick<UserActivityInterface, 'asset' | 'conditionId'>,
        localPositionSize = 0
    ) {
        return Math.max(
            this.stateStore.countSignalTickets(trade),
            localPositionSize > EPSILON ? 1 : 0
        );
    }

    private buildSecondSignalTicketTrail(nextTicketIndex: number, tierLabel: string) {
        if (nextTicketIndex !== 2) {
            return [];
        }

        return [
            buildPolicyTrailEntry(
                SIGNAL_SECOND_TICKET_POLICY_ID,
                'ADJUST',
                `同 condition/outcome 已进入第 ${nextTicketIndex} 枪，仅放行${tierLabel}`
            ),
        ];
    }

    private async flushSignalBuyBuffer(
        buffer: CopyIntentBufferInterface,
        options: { skipReason?: string; extraPolicyTrail?: ExecutionPolicyTrailEntry[] } = {}
    ) {
        const trades = this.stateStore.getTradesByIds(buffer.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        if (!latestTrade) {
            const reason = options.skipReason || '信号缓冲缺少关联源交易';
            buffer.state = 'SKIPPED';
            buffer.reason = reason;
            buffer.completedAt = Date.now();
            this.stateStore.closeBuffer(buffer._id, 'SKIPPED', reason);
            this.queuePersistBuffer(buffer);
            return;
        }

        let finalPolicyTrail = mergePolicyTrail(buffer.policyTrail, options.extraPolicyTrail);
        const finalizeSignalSkip = (reason: string) => {
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
            logger.debug(`${buffer.bufferKey} 已放弃 live 信号缓冲 reason=${reason}`);
        };

        const context = await this.refreshTradingContext(true);
        if (context.availableBalance === null) {
            finalizeSignalSkip(options.skipReason || '代理钱包可用余额接口不可用');
            return;
        }

        const existingPosition = findPositionForTrade(context.positions, latestTrade);
        const localPositionSize = Math.max(toSafeNumber(existingPosition?.size), 0);
        const signalTicketCount = this.getSignalTicketCountForTrade(latestTrade, localPositionSize);
        const signalEvaluation = evaluateBufferedSignalBuy({
            sourceUsdcTotal: buffer.sourceUsdcTotal,
            sourceTradeCount: buffer.sourceTradeCount,
            existingTicketCount: signalTicketCount,
            maxTicketsPerCondition: FOLLOW_MAX_TICKETS_PER_CONDITION,
        });
        finalPolicyTrail = mergePolicyTrail(
            buffer.policyTrail,
            options.extraPolicyTrail,
            signalEvaluation.policyTrail,
            signalEvaluation.status === 'EXECUTE'
                ? this.buildSecondSignalTicketTrail(
                      signalEvaluation.nextTicketIndex,
                      getSignalTierLabel(signalEvaluation.tier)
                  )
                : []
        );

        if (signalEvaluation.status === 'SKIP') {
            finalizeSignalSkip(
                options.skipReason || mergeReasons(buffer.reason, signalEvaluation.reason)
            );
            return;
        }

        const openPositionsCount = countOpenLivePositions(context.positions);
        if (localPositionSize <= EPSILON && openPositionsCount >= FOLLOW_MAX_OPEN_POSITIONS) {
            finalizeSignalSkip(
                options.skipReason ||
                    `当前 open positions=${openPositionsCount}，已达到固定票据上限 ${FOLLOW_MAX_OPEN_POSITIONS}`
            );
            return;
        }

        const reservedBuyExposureUsdc = this.stateStore.reservedBuyExposureUsdc();
        const availableBalance = Math.max(
            toSafeNumber(context.availableBalance) - reservedBuyExposureUsdc,
            0
        );
        if (availableBalance + EPSILON < signalEvaluation.requestedUsdc) {
            finalizeSignalSkip(
                options.skipReason ||
                    `本地可用余额 ${formatAmount(availableBalance)} USDC 低于固定票据 ${formatAmount(signalEvaluation.requestedUsdc)} USDC`
            );
            return;
        }

        const activeExposureUsdc = buildLiveActiveExposureUsdc(context, reservedBuyExposureUsdc);
        if (
            activeExposureUsdc + signalEvaluation.requestedUsdc >
            FOLLOW_MAX_ACTIVE_EXPOSURE_USDC + EPSILON
        ) {
            finalizeSignalSkip(
                options.skipReason ||
                    `活跃暴露 ${formatAmount(activeExposureUsdc)} USDC 已接近上限 ${formatAmount(FOLLOW_MAX_ACTIVE_EXPOSURE_USDC)} USDC`
            );
            return;
        }

        const finalReason = mergeReasons(buffer.reason, signalEvaluation.reason);
        await this.createBatch({
            trades,
            bufferId: buffer._id,
            condition: 'buy',
            executionKind: 'TRADE',
            requestedUsdc: signalEvaluation.requestedUsdc,
            sourcePrice: Math.max(
                toSafeNumber(buffer.sourcePrice),
                toSafeNumber(latestTrade.price),
                0
            ),
            localPositionSizeBefore: localPositionSize,
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
            `${buffer.bufferKey} 已生成实盘信号批次 sourceUsdc=${formatAmount(buffer.sourceUsdcTotal)} requestedUsdc=${formatAmount(signalEvaluation.requestedUsdc)}`
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
            sourceUsdcTotal: getTradeSourceUsdc(trade),
            sourcePrice: Math.max(toSafeNumber(sourcePrice), toSafeNumber(trade.price), 0),
            flushAfter: nextFlushAt,
            reason: nextReason,
            policyTrail: nextPolicyTrail,
            bufferWindowMs: BUY_INTENT_BUFFER_MAX_MS,
            sizingMode: BUY_SIZING_MODE,
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

    private async bufferSignalBuyIntent(params: {
        trade: UserActivityInterface;
        sourceUsdc: number;
        reason?: string;
        policyTrail?: ExecutionPolicyTrailEntry[];
        existingTicketCount?: number;
    }) {
        const {
            trade,
            sourceUsdc,
            reason = '',
            policyTrail = [],
            existingTicketCount = 0,
        } = params;
        const normalizedSourceUsdc = Math.max(toSafeNumber(sourceUsdc), 0);
        if (normalizedSourceUsdc <= 0) {
            return;
        }

        let openBuffer = this.stateStore.getOpenBuffer(buildLiveBuyBufferKey(trade));
        if (openBuffer && shouldFlushBufferBeforeAppendingTrade(openBuffer, trade)) {
            await this.flushBuyBuffer(openBuffer, {
                extraPolicyTrail: [
                    buildPolicyTrailEntry(
                        SIGNAL_BUY_BUFFER_POLICY_ID,
                        'DEFER',
                        `检测到新的同资产信号，上一段累计窗口已超过 ${SIGNAL_BUFFER_MS}ms`
                    ),
                ],
            });
            openBuffer = null;
        }

        const nextSourceUsdc =
            Math.max(toSafeNumber(openBuffer?.sourceUsdcTotal), 0) + normalizedSourceUsdc;
        const nextSourceTradeCount =
            Math.max(toSafeNumber(openBuffer?.sourceTradeCount), 0) + getSourceTradeCount(trade);
        const signalEvaluation = evaluateBufferedSignalBuy({
            sourceUsdcTotal: nextSourceUsdc,
            sourceTradeCount: nextSourceTradeCount,
            existingTicketCount,
            maxTicketsPerCondition: FOLLOW_MAX_TICKETS_PER_CONDITION,
        });
        const flushImmediately = signalEvaluation.status === 'EXECUTE';
        const nextFlushAt = flushImmediately ? Date.now() : Date.now() + SIGNAL_BUFFER_MS;
        const nextReason = mergeReasons(openBuffer?.reason, reason);
        const nextPolicyTrail = mergePolicyTrail(openBuffer?.policyTrail, policyTrail, [
            buildPolicyTrailEntry(
                SIGNAL_BUY_BUFFER_POLICY_ID,
                'DEFER',
                flushImmediately
                    ? `累计源买单 ${nextSourceUsdc.toFixed(4)} USDC / ${nextSourceTradeCount} 笔，已达到固定票据触发阈值`
                    : `累计源买单 ${nextSourceUsdc.toFixed(4)} USDC / ${nextSourceTradeCount} 笔，继续等待 ${SIGNAL_BUFFER_MS}ms 窗口收敛`
            ),
        ]);

        const nextBuffer = this.stateStore.mergeIntoOpenBuffer(openBuffer, {
            trade,
            bufferKey: buildLiveBuyBufferKey(trade),
            requestedUsdc: 0,
            sourceUsdcTotal: normalizedSourceUsdc,
            sourcePrice: Math.max(toSafeNumber(trade.price), 0),
            flushAfter: nextFlushAt,
            reason: nextReason,
            policyTrail: nextPolicyTrail,
            bufferWindowMs: SIGNAL_BUFFER_MS,
            sizingMode: 'signal_fixed_ticket',
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

                const blockingBatch = this.stateStore.findBlockingBatch(trade);
                if (blockingBatch) {
                    const reason = `同资产存在未确认批次 ${String(blockingBatch._id)}，等待前序 ${blockingBatch.condition} 确认后再继续`;
                    this.stateStore.markTradePending(trade, reason);
                    state.lastError = reason;
                    this.queuePersistSingleTradeState(state);
                    logger.warn(`${formatTradeRef(trade)} 暂缓入批 reason=${reason}`);
                    continue;
                }

                const tradeAction = resolveTradeAction(trade);
                if (tradeAction === 'BUY') {
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
                                    openBuffer.sizingMode === 'signal_fixed_ticket'
                                        ? SIGNAL_BUY_BUFFER_POLICY_ID
                                        : LIVE_BUY_BUFFER_POLICY_ID,
                                    'DEFER',
                                    openBuffer.sizingMode === 'signal_fixed_ticket'
                                        ? `检测到新的同资产信号，上一段累计窗口已超过 ${SIGNAL_BUFFER_MS}ms`
                                        : `检测到新的同资产买单，上一段累计窗口已超过 ${BUY_INTENT_BUFFER_MAX_MS}ms`
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

                    if (BUY_SIZING_MODE === 'signal_fixed_ticket') {
                        const signalTradeEvaluation = evaluateSignalBuyTrade(trade);
                        if (signalTradeEvaluation.status === 'SKIP') {
                            this.finalizeTradeState(
                                state,
                                'SKIPPED',
                                signalTradeEvaluation.reason,
                                signalTradeEvaluation.policyTrail
                            );
                            continue;
                        }

                        const signalTicketCount = this.getSignalTicketCountForTrade(
                            trade,
                            Math.max(toSafeNumber(existingPosition?.size), 0)
                        );
                        if (
                            latestBuffer === null &&
                            signalTicketCount >= FOLLOW_MAX_TICKETS_PER_CONDITION
                        ) {
                            const reason = buildSignalMaxTicketsReason();
                            this.finalizeTradeState(state, 'SKIPPED', reason, [
                                buildPolicyTrailEntry(SIGNAL_MAX_TICKETS_POLICY_ID, 'SKIP', reason),
                            ]);
                            continue;
                        }

                        await this.bufferSignalBuyIntent({
                            trade,
                            sourceUsdc: signalTradeEvaluation.sourceUsdc,
                            reason: signalTradeEvaluation.reason,
                            policyTrail: signalTradeEvaluation.policyTrail,
                            existingTicketCount: signalTicketCount,
                        });
                        logger.debug(
                            `${formatTradeRef(trade)} 已写入实盘信号缓冲 sourceUsdc=${formatAmount(signalTradeEvaluation.sourceUsdc)}`
                        );
                        continue;
                    }

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
                        executionKind: 'TRADE',
                        requestedUsdc: evaluation.requestedUsdc,
                        sourcePrice: evaluation.sourcePrice,
                        localPositionSizeBefore: Math.max(toSafeNumber(existingPosition?.size), 0),
                        reason: evaluation.reason,
                        policyTrail: evaluation.policyTrail,
                    });
                    continue;
                }

                const context = await this.refreshTradingContext();
                if (context.skipReason) {
                    this.stateStore.markTradePending(trade, context.skipReason);
                    state.lastError = context.skipReason;
                    this.queuePersistSingleTradeState(state);
                    logger.warn(`${formatTradeRef(trade)} 暂缓入批 reason=${context.skipReason}`);
                    continue;
                }

                await this.cancelOpenBuyBuffersForAsset(trade);
                await this.cancelReadyBuyBatchesForAsset(trade);
                if (tradeAction === 'MERGE') {
                    const mergePlan = this.buildMergeExecutionPlan(trade, context.positions);
                    if (mergePlan.status === 'RETRY') {
                        state.retryCount += 1;
                        if (state.retryCount >= RETRY_LIMIT) {
                            this.finalizeTradeState(state, 'FAILED', mergePlan.reason);
                        } else {
                            this.stateStore.markTradePending(trade, mergePlan.reason);
                            state.lastError = mergePlan.reason;
                            this.queuePersistSingleTradeState(state);
                            logger.warn(
                                `${formatTradeRef(trade)} 待重试 reason=${mergePlan.reason}`
                            );
                        }
                        continue;
                    }

                    if (mergePlan.status === 'SKIPPED') {
                        this.finalizeTradeState(
                            state,
                            'SKIPPED',
                            mergePlan.reason,
                            mergePlan.policyTrail
                        );
                        continue;
                    }

                    const existingPosition = findPositionForTrade(context.positions, trade);
                    await this.createBatch({
                        trades: [trade],
                        condition: 'merge',
                        executionKind: 'MERGE',
                        requestedUsdc: mergePlan.requestedSize,
                        requestedSize: mergePlan.requestedSize,
                        sourcePrice: Math.max(toSafeNumber(trade.price), 1),
                        localPositionSizeBefore: Math.max(toSafeNumber(existingPosition?.size), 0),
                        localConditionMergeableSizeBefore: mergePlan.localMergeableBefore,
                        reason: mergePlan.reason,
                        policyTrail: mergePlan.policyTrail,
                    });
                    continue;
                }

                const existingPosition = findPositionForTrade(context.positions, trade);
                const sourcePositionAfterTrade = {
                    size: trade.sourcePositionSizeAfterTrade,
                };
                await this.createBatch({
                    trades: [trade],
                    condition: resolveTradeCondition(
                        tradeAction,
                        existingPosition,
                        sourcePositionAfterTrade
                    ),
                    executionKind: 'TRADE',
                    localPositionSizeBefore: Math.max(toSafeNumber(existingPosition?.size), 0),
                    sourcePrice: Math.max(toSafeNumber(trade.price), 0),
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

            const blockingBatch = this.stateStore.findBlockingBatch(latestTrade, claimedBatch._id);
            if (blockingBatch) {
                const reason = `同资产存在未确认批次 ${String(blockingBatch._id)}，等待前序 ${blockingBatch.condition} 确认后再执行`;
                this.stateStore.markBatchReady(claimedBatch._id, reason);
                claimedBatch.reason = reason;
                this.queuePersistBatch(claimedBatch);
                return;
            }

            const context = await this.refreshTradingContext(true);
            if (context.skipReason) {
                this.stateStore.markBatchReady(claimedBatch._id, context.skipReason);
                claimedBatch.reason = context.skipReason;
                this.queuePersistBatch(claimedBatch);
                return;
            }

            if (claimedBatch.condition === 'buy' && context.availableBalance === null) {
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
                resolveTradeCondition(
                    resolveTradeAction(latestTrade),
                    myPosition,
                    sourcePositionAfterTrade
                );
            const result =
                claimedBatch.executionKind === 'MERGE'
                    ? await (async () => {
                          const mergeResult = await postConditionMerge({
                              conditionId: latestTrade.conditionId,
                              partition: this.buildConditionPartition(
                                  latestTrade,
                                  context.positions
                              ),
                              requestedSize:
                                  claimedBatch.requestedSize > 0
                                      ? claimedBatch.requestedSize
                                      : claimedBatch.requestedUsdc,
                              note: claimedBatch.reason,
                          });
                          return {
                              ...mergeResult,
                              orderIds: [],
                          };
                      })()
                    : await postOrder(
                          this.clobClient,
                          this.marketStream,
                          condition,
                          myPosition,
                          sourcePositionAfterTrade,
                          latestTrade,
                          context.availableBalance || 0,
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
                                        claimedBatch.sourcePrice > 0
                                            ? claimedBatch.sourcePrice
                                            : undefined,
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

            if ((result.orderIds || []).length > 0 || (result.transactionHashes || []).length > 0) {
                claimedBatch.reason = result.reason;
                claimedBatch.orderIds = result.orderIds || [];
                claimedBatch.transactionHashes = result.transactionHashes || [];
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
                    `${formatBatchRef(claimedBatch)} 已提交 orderIds=${(result.orderIds || []).length} txHashes=${(result.transactionHashes || []).length}`
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

            if (batch.status === 'TIMEOUT') {
                await this.reconcileTimedOutBatch(batch, latestTrade);
                return;
            }

            const pendingBatch =
                batch.status === 'SUBMITTED'
                    ? this.markBatchPendingConfirmation(
                          batch,
                          mergeReasons(batch.reason, '已提交，等待订单流或链上确认'),
                          batch.submissionStatus
                      ) || batch
                    : batch;
            const orderIds = (batch.orderIds || []).filter(Boolean);
            if (pendingBatch.executionKind !== 'MERGE' && this.userStream && orderIds.length > 0) {
                const userConfirmation = await this.userStream.waitForOrders({
                    conditionId: latestTrade.conditionId,
                    orderIds,
                    timeoutMs: LIVE_CONFIRM_TIMEOUT_MS,
                    onStatus: async (update: UserChannelStatusUpdate) => {
                        pendingBatch.reason = mergeReasons(pendingBatch.reason, update.reason);
                        if (update.confirmedAt) {
                            pendingBatch.confirmedAt = update.confirmedAt;
                        }
                        if (update.status && update.status !== 'SUBMITTED') {
                            pendingBatch.submissionStatus = update.status;
                        }
                        this.queuePersistBatchProgress(pendingBatch, update);
                    },
                });

                if (userConfirmation.confirmationStatus === 'CONFIRMED') {
                    pendingBatch.lastConfirmationSource = 'user_stream';
                    this.finalizeBatch(
                        pendingBatch,
                        'CONFIRMED',
                        mergeReasons(pendingBatch.reason, userConfirmation.reason),
                        userConfirmation.confirmedAt
                    );
                    return;
                }

                if (userConfirmation.confirmationStatus === 'FAILED') {
                    this.finalizeBatch(
                        pendingBatch,
                        'FAILED',
                        mergeReasons(pendingBatch.reason, userConfirmation.reason)
                    );
                    return;
                }

                const chainConfirmation = await confirmTransactionHashes(
                    pendingBatch.transactionHashes || [],
                    {
                        timeoutMs: LIVE_RECONCILE_AFTER_TIMEOUT_MS,
                    }
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
                this.queuePersistBatchProgress(pendingBatch, update);

                if (chainConfirmation.status === 'CONFIRMED') {
                    pendingBatch.lastConfirmationSource = 'chain';
                    this.finalizeBatch(
                        pendingBatch,
                        'CONFIRMED',
                        mergeReasons(
                            pendingBatch.reason,
                            userConfirmation.reason,
                            chainConfirmation.reason
                        ),
                        chainConfirmation.confirmedAt
                    );
                    return;
                }

                if (chainConfirmation.status === 'FAILED') {
                    this.finalizeBatch(
                        pendingBatch,
                        'FAILED',
                        mergeReasons(
                            pendingBatch.reason,
                            userConfirmation.reason,
                            chainConfirmation.reason
                        )
                    );
                    return;
                }

                const timeoutReason = mergeReasons(
                    pendingBatch.reason,
                    userConfirmation.reason,
                    chainConfirmation.reason,
                    `等待真实确认超时（${LIVE_CONFIRM_TIMEOUT_MS}ms）`
                );
                this.markBatchTimeout(pendingBatch, timeoutReason);
                logger.warn(
                    `${formatBatchRef(pendingBatch)} 确认超时，开始补偿对账 reason=${timeoutReason}`
                );
                await this.reconcileTimedOutBatch(pendingBatch, latestTrade);
                return;
            }

            const chainConfirmation = await confirmTransactionHashes(
                pendingBatch.transactionHashes || [],
                {
                    timeoutMs: LIVE_CONFIRM_TIMEOUT_MS,
                }
            );
            if (chainConfirmation.status === 'CONFIRMED') {
                pendingBatch.lastConfirmationSource = 'chain';
                this.finalizeBatch(
                    pendingBatch,
                    'CONFIRMED',
                    mergeReasons(pendingBatch.reason, chainConfirmation.reason),
                    chainConfirmation.confirmedAt
                );
                return;
            }

            if (chainConfirmation.status === 'FAILED') {
                this.finalizeBatch(
                    pendingBatch,
                    'FAILED',
                    mergeReasons(pendingBatch.reason, chainConfirmation.reason)
                );
                return;
            }

            const timeoutReason = mergeReasons(
                pendingBatch.reason,
                chainConfirmation.reason,
                `等待真实确认超时（${LIVE_CONFIRM_TIMEOUT_MS}ms）`
            );
            this.markBatchTimeout(pendingBatch, timeoutReason);
            logger.warn(
                `${formatBatchRef(pendingBatch)} 确认超时，开始补偿对账 reason=${timeoutReason}`
            );
            await this.reconcileTimedOutBatch(pendingBatch, latestTrade);
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
