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
import confirmTransactionHashes from '../utils/confirmTransactionHashes';
import { evaluateDirectBuyIntent, sortTradesAsc } from '../utils/copyIntentPlanning';
import fetchData from '../utils/fetchData';
import getTradingGuardState from '../utils/getTradingGuardState';
import createLogger from '../utils/logger';
import postOrder, { PostOrderResult } from '../utils/postOrder';
import {
    fetchPolymarketMarketResolution,
    isResolvedPolymarketMarket,
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
import spinner from '../utils/spinner';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROCESSING_LEASE_MS = ENV.PROCESSING_LEASE_MS;
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}&sizeThreshold=0`;
const logger = createLogger('live');

const UserActivity = getUserActivityModel(USER_ADDRESS);
const CopyIntentBuffer = getCopyIntentBufferModel(USER_ADDRESS);
const CopyExecutionBatch = getCopyExecutionBatchModel(USER_ADDRESS);

const findPositionForTrade = (
    positions: UserPositionInterface[],
    trade: UserActivityInterface
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const formatAmount = (value: unknown) => toSafeNumber(value).toFixed(4);
const formatTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset' | 'side'>) =>
    `tx=${trade.transactionHash} side=${String(trade.side || '').toUpperCase()} asset=${trade.asset}`;
const formatBatchRef = (
    batch: Pick<CopyExecutionBatchInterface, 'asset' | 'condition' | 'sourceTradeCount'>
) => `condition=${batch.condition} asset=${batch.asset} trades=${batch.sourceTradeCount}`;
const formatTerminalStatus = (status: 'CONFIRMED' | 'SKIPPED' | 'FAILED') =>
    status === 'CONFIRMED' ? '已确认' : status === 'SKIPPED' ? '已跳过' : '已失败';

const buildLeaseCutoff = () => Date.now() - PROCESSING_LEASE_MS;
const buildClaimableFilter = (fieldName: string, leaseCutoff: number) => ({
    $or: [
        { [fieldName]: { $exists: false } },
        { [fieldName]: 0 },
        { [fieldName]: { $lt: leaseCutoff } },
    ],
});

const buildReclaimableProcessingTradeFilter = (leaseCutoff: number) => ({
    botStatus: 'PROCESSING',
    botClaimedAt: { $lt: leaseCutoff },
    $and: [
        {
            $or: [{ botOrderIds: { $exists: false } }, { 'botOrderIds.0': { $exists: false } }],
        },
        {
            $or: [{ botSubmittedAt: { $exists: false } }, { botSubmittedAt: 0 }],
        },
    ],
});

const buildReclaimableReadyBatchFilter = (leaseCutoff: number) => ({
    status: 'PROCESSING',
    claimedAt: { $lt: leaseCutoff },
    $and: [{ $or: [{ submittedAt: { $exists: false } }, { submittedAt: 0 }] }],
});

const readPendingTrades = async () =>
    (await UserActivity.find({
        $and: [
            { type: 'TRADE' },
            {
                $or: [{ executionIntent: 'EXECUTE' }, { executionIntent: { $exists: false } }],
            },
            { transactionHash: { $exists: true, $ne: '' } },
            { bot: { $ne: true } },
            {
                $or: [
                    { botStatus: { $exists: false } },
                    { botStatus: 'PENDING' },
                    buildReclaimableProcessingTradeFilter(buildLeaseCutoff()),
                ],
            },
            {
                $or: [
                    { botExcutedTime: { $exists: false } },
                    { botExcutedTime: { $lt: RETRY_LIMIT } },
                ],
            },
        ],
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];

const readSubmittedTrades = async () =>
    (await UserActivity.find({
        $and: [
            { type: 'TRADE' },
            {
                $or: [{ executionIntent: 'EXECUTE' }, { executionIntent: { $exists: false } }],
            },
            { transactionHash: { $exists: true, $ne: '' } },
            { bot: { $ne: true } },
            { botStatus: 'SUBMITTED' },
            { $or: [{ botExecutionBatchId: { $exists: false } }, { botExecutionBatchId: null }] },
            buildClaimableFilter('botClaimedAt', buildLeaseCutoff()),
            {
                $or: [
                    { 'botTransactionHashes.0': { $exists: true } },
                    { 'botOrderIds.0': { $exists: true } },
                ],
            },
        ],
    })
        .sort({ botSubmittedAt: 1, timestamp: 1 })
        .exec()) as UserActivityInterface[];

const readReadyBatches = async () =>
    (await CopyExecutionBatch.find({
        $and: [
            {
                $or: [
                    {
                        status: 'READY',
                        ...buildClaimableFilter('claimedAt', buildLeaseCutoff()),
                    },
                    buildReclaimableReadyBatchFilter(buildLeaseCutoff()),
                ],
            },
            {
                $or: [{ retryCount: { $exists: false } }, { retryCount: { $lt: RETRY_LIMIT } }],
            },
        ],
    })
        .sort({ sourceStartedAt: 1, createdAt: 1 })
        .exec()) as CopyExecutionBatchInterface[];

const readSubmittedBatches = async () =>
    (await CopyExecutionBatch.find({
        $and: [
            { status: 'SUBMITTED' },
            buildClaimableFilter('claimedAt', buildLeaseCutoff()),
            {
                $or: [
                    { 'transactionHashes.0': { $exists: true } },
                    { 'orderIds.0': { $exists: true } },
                ],
            },
        ],
    })
        .sort({ submittedAt: 1, sourceStartedAt: 1 })
        .exec()) as CopyExecutionBatchInterface[];

const loadTradesByIds = async (tradeIds: UserActivityInterface['_id'][]) =>
    (await UserActivity.find({
        _id: {
            $in: tradeIds,
        },
    })
        .sort({ timestamp: 1 })
        .exec()) as UserActivityInterface[];

const claimTrade = async (trade: UserActivityInterface) => {
    const result = await UserActivity.updateOne(
        {
            _id: trade._id,
            bot: { $ne: true },
            $or: [
                { botStatus: { $exists: false } },
                { botStatus: 'PENDING' },
                buildReclaimableProcessingTradeFilter(buildLeaseCutoff()),
            ],
        },
        {
            $set: {
                botStatus: 'PROCESSING',
                botClaimedAt: Date.now(),
                botLastError: '',
            },
        }
    );

    return result.modifiedCount === 1;
};

const claimSubmittedTrade = async (trade: UserActivityInterface) => {
    const result = await UserActivity.updateOne(
        {
            _id: trade._id,
            botStatus: 'SUBMITTED',
            ...buildClaimableFilter('botClaimedAt', buildLeaseCutoff()),
        },
        {
            $set: {
                botClaimedAt: Date.now(),
            },
        }
    );

    return result.modifiedCount === 1;
};

const claimReadyBatch = async (batch: CopyExecutionBatchInterface) => {
    const result = await CopyExecutionBatch.updateOne(
        {
            _id: batch._id,
            $or: [
                {
                    status: 'READY',
                    ...buildClaimableFilter('claimedAt', buildLeaseCutoff()),
                },
                buildReclaimableReadyBatchFilter(buildLeaseCutoff()),
            ],
        },
        {
            $set: {
                status: 'PROCESSING',
                claimedAt: Date.now(),
            },
        }
    );

    return result.modifiedCount === 1;
};

const claimSubmittedBatch = async (batch: CopyExecutionBatchInterface) => {
    const result = await CopyExecutionBatch.updateOne(
        {
            _id: batch._id,
            status: 'SUBMITTED',
            ...buildClaimableFilter('claimedAt', buildLeaseCutoff()),
        },
        {
            $set: {
                claimedAt: Date.now(),
            },
        }
    );

    return result.modifiedCount === 1;
};

const finalizeRetryableTrade = async (trade: UserActivityInterface, reason: string) => {
    const nextRetryCount = Number(trade.botExcutedTime || 0) + 1;

    if (nextRetryCount >= RETRY_LIMIT) {
        await UserActivity.updateOne(
            { _id: trade._id },
            {
                $set: {
                    bot: true,
                    botStatus: 'FAILED',
                    botExecutedAt: Date.now(),
                    botClaimedAt: 0,
                    botLastError: reason,
                },
                $inc: {
                    botExcutedTime: 1,
                },
            }
        );
        return;
    }

    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: {
                bot: false,
                botStatus: 'PENDING',
                botClaimedAt: 0,
                botLastError: reason,
            },
            $inc: {
                botExcutedTime: 1,
            },
        }
    );
};

const releaseClaimedTrade = async (trade: UserActivityInterface, reason: string) => {
    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: {
                bot: false,
                botStatus: 'PENDING',
                botClaimedAt: 0,
                botLastError: reason,
            },
        }
    );
};

const finalizeTerminalTrade = async (
    trade: UserActivityInterface,
    status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
    reason: string,
    confirmedAt?: number
) => {
    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: {
                bot: true,
                botStatus: status,
                botExecutedAt: Date.now(),
                botClaimedAt: 0,
                botLastError: reason,
                botConfirmedAt: confirmedAt || 0,
                botSubmissionStatus:
                    status === 'CONFIRMED'
                        ? 'CONFIRMED'
                        : status === 'FAILED'
                          ? 'FAILED'
                          : trade.botSubmissionStatus || 'SUBMITTED',
            },
        }
    );
};

const finalizeRetryableTradeWithLog = async (trade: UserActivityInterface, reason: string) => {
    const nextRetryCount = Number(trade.botExcutedTime || 0) + 1;
    await finalizeRetryableTrade(trade, reason);

    if (nextRetryCount >= RETRY_LIMIT) {
        logger.error(`${formatTradeRef(trade)} 已失败 reason=${reason}`);
        return;
    }

    logger.warn(`${formatTradeRef(trade)} 待重试 reason=${reason}`);
};

const finalizeTerminalTradeWithLog = async (
    trade: UserActivityInterface,
    status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
    reason: string,
    confirmedAt?: number
) => {
    await finalizeTerminalTrade(trade, status, reason, confirmedAt);

    const message = [
        `${formatTradeRef(trade)} ${formatTerminalStatus(status)}`,
        reason ? `reason=${reason}` : '',
        confirmedAt ? `confirmedAt=${confirmedAt}` : '',
    ]
        .filter(Boolean)
        .join(' ');

    if (status === 'FAILED') {
        logger.error(message);
        return;
    }

    logger.info(message);
};

const finalizeActivitiesByIds = async (
    tradeIds: UserActivityInterface['_id'][],
    status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
    reason: string,
    batchId: CopyExecutionBatchInterface['_id'] | null,
    trail: ExecutionPolicyTrailEntry[],
    update: Partial<UserActivityInterface> = {}
) => {
    if (tradeIds.length === 0) {
        return;
    }

    await UserActivity.updateMany(
        {
            _id: { $in: tradeIds },
        },
        {
            $set: {
                bot: true,
                botStatus: status,
                botExecutedAt: Date.now(),
                botClaimedAt: 0,
                botLastError: reason,
                botExecutionBatchId: batchId || undefined,
                botPolicyTrail: trail,
                botSubmissionStatus:
                    status === 'CONFIRMED'
                        ? 'CONFIRMED'
                        : status === 'FAILED'
                          ? 'FAILED'
                          : update.botSubmissionStatus || 'SUBMITTED',
                ...update,
            },
        }
    );
};

const finalizeSingleTradeWithTrail = async (
    trade: UserActivityInterface,
    status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
    reason: string,
    trail: ExecutionPolicyTrailEntry[],
    confirmedAt?: number
) => {
    await finalizeActivitiesByIds([trade._id], status, reason, null, trail, {
        botConfirmedAt: confirmedAt || 0,
    });
};

const updateBatchedActivities = async (
    tradeIds: UserActivityInterface['_id'][],
    batchId: CopyExecutionBatchInterface['_id'],
    reason: string,
    trail: ExecutionPolicyTrailEntry[],
    bufferId?: CopyIntentBufferInterface['_id']
) => {
    if (tradeIds.length === 0) {
        return;
    }

    await UserActivity.updateMany(
        {
            _id: { $in: tradeIds },
        },
        {
            $set: {
                bot: false,
                botStatus: 'BATCHED',
                botExecutionBatchId: batchId,
                botBufferId: bufferId,
                botClaimedAt: 0,
                botLastError: reason,
                botPolicyTrail: trail,
            },
        }
    );
};

const updateSubmittedActivities = async (
    tradeIds: UserActivityInterface['_id'][],
    batchId: CopyExecutionBatchInterface['_id'],
    result: PostOrderResult,
    trail: ExecutionPolicyTrailEntry[]
) => {
    if (tradeIds.length === 0) {
        return;
    }

    await UserActivity.updateMany(
        {
            _id: { $in: tradeIds },
        },
        {
            $set: {
                bot: false,
                botStatus: 'SUBMITTED',
                botExecutionBatchId: batchId,
                botSubmittedAt: Date.now(),
                botClaimedAt: Date.now(),
                botLastError: result.reason,
                botOrderIds: result.orderIds,
                botTransactionHashes: result.transactionHashes,
                botSubmissionStatus: result.submissionStatus || 'SUBMITTED',
                botMatchedAt: 0,
                botMinedAt: 0,
                botConfirmedAt: 0,
                botPolicyTrail: trail,
            },
        }
    );
};

const releaseReadyBatch = async (batch: CopyExecutionBatchInterface, reason: string) => {
    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status: 'READY',
                claimedAt: 0,
                reason,
            },
        }
    );
    await UserActivity.updateMany(
        {
            _id: { $in: batch.sourceTradeIds },
        },
        {
            $set: {
                botStatus: 'BATCHED',
                botClaimedAt: 0,
                botLastError: reason,
            },
        }
    );
};

const retryBatchExecution = async (batch: CopyExecutionBatchInterface, reason: string) => {
    const nextRetryCount = Number(batch.retryCount || 0) + 1;
    if (nextRetryCount >= RETRY_LIMIT) {
        await finalizeBatchAndActivities(batch, 'FAILED', reason);
        logger.error(`${formatBatchRef(batch)} 已失败 reason=${reason}`);
        return;
    }

    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status: 'READY',
                claimedAt: 0,
                reason,
            },
            $inc: {
                retryCount: 1,
            },
        }
    );
    await UserActivity.updateMany(
        {
            _id: { $in: batch.sourceTradeIds },
        },
        {
            $set: {
                botStatus: 'BATCHED',
                botClaimedAt: 0,
                botLastError: reason,
            },
        }
    );
    logger.warn(`${formatBatchRef(batch)} 待重试 reason=${reason}`);
};

const finalizeBatchAndActivities = async (
    batch: CopyExecutionBatchInterface,
    status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
    reason: string,
    confirmedAt?: number
) => {
    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status,
                reason,
                claimedAt: 0,
                confirmedAt: confirmedAt || 0,
                completedAt: Date.now(),
                submissionStatus:
                    status === 'CONFIRMED'
                        ? 'CONFIRMED'
                        : status === 'FAILED'
                          ? 'FAILED'
                          : batch.submissionStatus || 'SUBMITTED',
            },
        }
    );

    await finalizeActivitiesByIds(
        batch.sourceTradeIds,
        status,
        reason,
        batch._id,
        batch.policyTrail || [],
        {
            botConfirmedAt: confirmedAt || 0,
        }
    );
};

const closeBuffer = async (
    buffer: CopyIntentBufferInterface,
    state: 'CLOSED' | 'SKIPPED',
    reason: string,
    trail: ExecutionPolicyTrailEntry[]
) => {
    await CopyIntentBuffer.updateOne(
        { _id: buffer._id },
        {
            $set: {
                state,
                claimedAt: 0,
                reason,
                policyTrail: trail,
                completedAt: Date.now(),
            },
        }
    );
};

const syncSubmittedTradeProgress = async (
    trade: UserActivityInterface,
    update: UserChannelStatusUpdate
) => {
    const updateSet: Record<string, unknown> = {
        botLastError: update.reason,
    };

    if (update.status && update.status !== 'SUBMITTED') {
        updateSet.botSubmissionStatus = update.status;
    }

    if (update.matchedAt) {
        updateSet.botMatchedAt = update.matchedAt;
    }

    if (update.minedAt) {
        updateSet.botMinedAt = update.minedAt;
    }

    if (update.confirmedAt) {
        updateSet.botConfirmedAt = update.confirmedAt;
    }

    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: updateSet,
        }
    );
};

const syncSubmittedBatchProgress = async (
    batch: CopyExecutionBatchInterface,
    update: UserChannelStatusUpdate
) => {
    const updateSet: Record<string, unknown> = {
        reason: update.reason,
    };

    if (update.status && update.status !== 'SUBMITTED') {
        updateSet.submissionStatus = update.status;
    }

    if (update.confirmedAt) {
        updateSet.confirmedAt = update.confirmedAt;
    }

    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: updateSet,
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
};

const markTradeSubmitted = async (trade: UserActivityInterface, result: PostOrderResult) => {
    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: {
                bot: false,
                botStatus: 'SUBMITTED',
                botSubmittedAt: Date.now(),
                botClaimedAt: Date.now(),
                botLastError: result.reason,
                botOrderIds: result.orderIds,
                botTransactionHashes: result.transactionHashes,
                botSubmissionStatus: result.submissionStatus || 'SUBMITTED',
                botMatchedAt: 0,
                botMinedAt: 0,
                botConfirmedAt: 0,
            },
        }
    );
};

const markBatchSubmitted = async (batch: CopyExecutionBatchInterface, result: PostOrderResult) => {
    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status: 'SUBMITTED',
                submittedAt: Date.now(),
                claimedAt: Date.now(),
                reason: result.reason,
                orderIds: result.orderIds,
                transactionHashes: result.transactionHashes,
                submissionStatus: result.submissionStatus || 'SUBMITTED',
            },
        }
    );
    await updateSubmittedActivities(
        batch.sourceTradeIds,
        batch._id,
        result,
        batch.policyTrail || []
    );
};

const releaseSubmittedTrade = async (trade: UserActivityInterface, reason: string) => {
    await UserActivity.updateOne(
        { _id: trade._id },
        {
            $set: {
                botStatus: 'SUBMITTED',
                botClaimedAt: 0,
                botLastError: reason,
            },
        }
    );
};

const releaseSubmittedBatch = async (batch: CopyExecutionBatchInterface, reason: string) => {
    await CopyExecutionBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status: 'SUBMITTED',
                claimedAt: 0,
                reason,
            },
        }
    );
    await UserActivity.updateMany(
        {
            _id: { $in: batch.sourceTradeIds },
        },
        {
            $set: {
                botStatus: 'SUBMITTED',
                botClaimedAt: 0,
                botLastError: reason,
            },
        }
    );
};

const confirmSubmittedTrade = async (
    trade: UserActivityInterface,
    userStream: ClobUserStream | null
) => {
    try {
        const orderIds = (trade.botOrderIds || []).filter(Boolean);
        let normalizedConfirmation;
        if (userStream && orderIds.length > 0) {
            normalizedConfirmation = await userStream.waitForOrders({
                conditionId: trade.conditionId,
                orderIds,
                onStatus: async (update: UserChannelStatusUpdate) => {
                    await syncSubmittedTradeProgress(trade, update);
                },
            });
        } else {
            const chainConfirmation = await confirmTransactionHashes(
                trade.botTransactionHashes || []
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
            await syncSubmittedTradeProgress(trade, update);
            normalizedConfirmation = {
                confirmationStatus: chainConfirmation.status,
                ...update,
            };
        }

        if (normalizedConfirmation.confirmationStatus === 'PENDING') {
            const reason = mergeReasons(trade.botLastError || '', normalizedConfirmation.reason);
            await releaseSubmittedTrade(trade, reason);
            logger.warn(`${formatTradeRef(trade)} 等待确认，稍后重试 reason=${reason}`);
            return;
        }

        if (normalizedConfirmation.confirmationStatus === 'FAILED') {
            await finalizeTerminalTradeWithLog(
                trade,
                'FAILED',
                mergeReasons(trade.botLastError || '', normalizedConfirmation.reason)
            );
            return;
        }

        const finalStatus =
            normalizedConfirmation.status === 'FAILED' || trade.botSubmissionStatus === 'FAILED'
                ? 'FAILED'
                : 'CONFIRMED';
        await finalizeTerminalTradeWithLog(
            trade,
            finalStatus,
            normalizedConfirmation.reason,
            normalizedConfirmation.confirmedAt
        );
    } catch (error) {
        logger.error(`${formatTradeRef(trade)} 确认异常`, error);
        await releaseSubmittedTrade(trade, 'User Channel 确认查询失败，稍后重试');
    }
};

const confirmSubmittedBatch = async (
    batch: CopyExecutionBatchInterface,
    userStream: ClobUserStream | null
) => {
    try {
        const trades = await loadTradesByIds(batch.sourceTradeIds);
        const latestTrade = sortTradesAsc(trades).slice(-1)[0];
        if (!latestTrade) {
            await finalizeBatchAndActivities(batch, 'FAILED', '批次缺少关联源交易');
            return;
        }

        const orderIds = (batch.orderIds || []).filter(Boolean);
        let normalizedConfirmation;
        if (userStream && orderIds.length > 0) {
            normalizedConfirmation = await userStream.waitForOrders({
                conditionId: latestTrade.conditionId,
                orderIds,
                onStatus: async (update: UserChannelStatusUpdate) => {
                    await syncSubmittedBatchProgress(batch, update);
                },
            });
        } else {
            const chainConfirmation = await confirmTransactionHashes(batch.transactionHashes || []);
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
            await syncSubmittedBatchProgress(batch, update);
            normalizedConfirmation = {
                confirmationStatus: chainConfirmation.status,
                ...update,
            };
        }

        if (normalizedConfirmation.confirmationStatus === 'PENDING') {
            const reason = mergeReasons(batch.reason || '', normalizedConfirmation.reason);
            await releaseSubmittedBatch(batch, reason);
            logger.warn(`${formatBatchRef(batch)} 等待确认，稍后重试 reason=${reason}`);
            return;
        }

        if (normalizedConfirmation.confirmationStatus === 'FAILED') {
            await finalizeBatchAndActivities(
                batch,
                'FAILED',
                mergeReasons(batch.reason || '', normalizedConfirmation.reason)
            );
            logger.error(
                `${formatBatchRef(batch)} 已失败 ` +
                    `reason=${mergeReasons(batch.reason || '', normalizedConfirmation.reason)}`
            );
            return;
        }

        const finalStatus =
            normalizedConfirmation.status === 'FAILED' || batch.submissionStatus === 'FAILED'
                ? 'FAILED'
                : 'CONFIRMED';
        await finalizeBatchAndActivities(
            batch,
            finalStatus,
            normalizedConfirmation.reason,
            normalizedConfirmation.confirmedAt
        );
        logger.info(
            `${formatBatchRef(batch)} ${formatTerminalStatus(finalStatus)} ` +
                (normalizedConfirmation.reason ? `reason=${normalizedConfirmation.reason}` : '')
        );
    } catch (error) {
        logger.error(`${formatBatchRef(batch)} 确认异常`, error);
        await releaseSubmittedBatch(batch, 'User Channel 确认查询失败，稍后重试');
    }
};

const syncSubmittedTrades = async (userStream: ClobUserStream | null) => {
    const submittedTrades = await readSubmittedTrades();
    if (submittedTrades.length === 0) {
        return;
    }

    logger.info(`检测到 ${submittedTrades.length} 条待确认交易，开始补偿确认`);

    for (const trade of submittedTrades) {
        const claimed = await claimSubmittedTrade(trade);
        if (!claimed) {
            continue;
        }

        await confirmSubmittedTrade(trade, userStream);
    }
};

const syncSubmittedBatches = async (userStream: ClobUserStream | null) => {
    const submittedBatches = await readSubmittedBatches();
    if (submittedBatches.length === 0) {
        return;
    }

    logger.info(`检测到 ${submittedBatches.length} 个待确认批次，开始补偿确认`);

    for (const batch of submittedBatches) {
        const claimed = await claimSubmittedBatch(batch);
        if (!claimed) {
            continue;
        }

        await confirmSubmittedBatch(batch, userStream);
    }
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

const cancelOpenBuyBuffersForAsset = async (
    trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
) => {
    const buffers = (await CopyIntentBuffer.find({
        state: 'OPEN',
        condition: 'buy',
        asset: trade.asset,
    }).exec()) as CopyIntentBufferInterface[];

    if (buffers.length === 0) {
        return;
    }

    const reason = `检测到 asset=${trade.asset} 的非买入源交易，已放弃未执行的累计买单`;
    const trail = [
        buildPolicyTrailEntry(
            'source-trade-merge',
            'SKIP',
            `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已关闭累计缓冲`
        ),
    ];

    for (const buffer of buffers) {
        const mergedTrail = mergePolicyTrail(buffer.policyTrail, trail);
        await closeBuffer(buffer, 'SKIPPED', reason, mergedTrail);
        await finalizeActivitiesByIds(buffer.sourceTradeIds, 'SKIPPED', reason, null, mergedTrail);
    }
};

const cancelReadyBuyBatchesForAsset = async (
    trade: Pick<UserActivityInterface, 'asset' | 'transactionHash'>
) => {
    const batches = (await CopyExecutionBatch.find({
        status: 'READY',
        condition: 'buy',
        asset: trade.asset,
    }).exec()) as CopyExecutionBatchInterface[];

    if (batches.length === 0) {
        return;
    }

    const reason = `检测到 asset=${trade.asset} 的非买入源交易，已取消未执行的买入批次`;
    const trail = [
        buildPolicyTrailEntry(
            'source-trade-merge',
            'SKIP',
            `检测到 tx=${trade.transactionHash} 的反向/非买入交易，已取消待执行买入批次`
        ),
    ];

    for (const batch of batches) {
        const mergedTrail = mergePolicyTrail(batch.policyTrail, trail);
        await CopyExecutionBatch.updateOne(
            { _id: batch._id },
            {
                $set: {
                    status: 'SKIPPED',
                    claimedAt: 0,
                    completedAt: Date.now(),
                    reason,
                    policyTrail: mergedTrail,
                    submissionStatus: 'SUBMITTED',
                },
            }
        );
        await finalizeActivitiesByIds(
            batch.sourceTradeIds,
            'SKIPPED',
            reason,
            batch._id,
            mergedTrail
        );
    }
};

const createBatchFromSingleTrade = async (
    trade: UserActivityInterface,
    params?: {
        condition?: string;
        requestedUsdc?: number;
        requestedSize?: number;
        sourcePrice?: number;
        reason?: string;
        policyTrail?: ExecutionPolicyTrailEntry[];
    }
) => {
    const condition =
        params?.condition ||
        resolveTradeCondition(trade.side, undefined, {
            size: trade.sourcePositionSizeAfterTrade,
        });
    const policyTrail = params?.policyTrail || [];
    const batch = await CopyExecutionBatch.create({
        sourceWallet: USER_ADDRESS,
        status: 'READY',
        condition,
        asset: trade.asset,
        conditionId: trade.conditionId,
        title: trade.title,
        outcome: trade.outcome,
        side: trade.side,
        sourceTradeIds: [trade._id],
        sourceActivityKeys: getSourceActivityKeys(trade),
        sourceTransactionHashes: getSourceTransactionHashes(trade),
        sourceTradeCount: getSourceTradeCount(trade),
        sourceStartedAt: getSourceStartedAt(trade),
        sourceEndedAt: getSourceEndedAt(trade),
        sourcePrice: Math.max(toSafeNumber(params?.sourcePrice), toSafeNumber(trade.price), 0),
        requestedUsdc: Math.max(toSafeNumber(params?.requestedUsdc), 0),
        requestedSize: Math.max(toSafeNumber(params?.requestedSize), 0),
        orderIds: [],
        transactionHashes: [],
        policyTrail,
        retryCount: 0,
        claimedAt: 0,
        submittedAt: 0,
        confirmedAt: 0,
        completedAt: 0,
        reason: params?.reason || '',
        submissionStatus: 'SUBMITTED',
    });
    await updateBatchedActivities(
        [trade._id],
        batch._id,
        params?.reason || '已创建执行批次',
        policyTrail
    );
};

const processPendingTrades = async (clobClient: ClobClient, trades: UserActivityInterface[]) => {
    let buyPlanningBalance: number | null | undefined;
    let buyPlanningReason = '';

    for (const trade of trades) {
        const claimed = await claimTrade(trade);
        if (!claimed) {
            continue;
        }

        try {
            const resolution = await fetchPolymarketMarketResolution({
                conditionId: trade.conditionId,
                marketSlug: String(trade.eventSlug || trade.slug || '').trim(),
                title: trade.title,
            });
            if (isResolvedPolymarketMarket(resolution)) {
                const reason =
                    `市场已 resolved winner=${resolution?.winnerOutcome || 'unknown'}，` +
                    '已跳过真实执行并交由结算回收器处理';
                await cancelOpenBuyBuffersForAsset(trade);
                await cancelReadyBuyBatchesForAsset(trade);
                await finalizeTerminalTradeWithLog(trade, 'SKIPPED', reason);
                continue;
            }

            const validation = validateTradeForExecution(trade);
            if (validation.status === 'SKIP') {
                await finalizeTerminalTradeWithLog(trade, 'SKIPPED', validation.reason);
                continue;
            }

            if (validation.status === 'RETRY') {
                await finalizeRetryableTradeWithLog(trade, validation.reason);
                continue;
            }

            const normalizedSide = String(trade.side || '').toUpperCase();
            if (normalizedSide === 'BUY') {
                if (buyPlanningBalance === undefined) {
                    const tradingGuardState = await getTradingGuardState(clobClient);
                    if (tradingGuardState.skipReason) {
                        buyPlanningReason = tradingGuardState.skipReason;
                        buyPlanningBalance = null;
                    } else if (tradingGuardState.availableBalance === null) {
                        buyPlanningReason = '代理钱包可用余额接口不可用';
                        buyPlanningBalance = null;
                    } else {
                        buyPlanningReason = '';
                        buyPlanningBalance = Math.max(
                            toSafeNumber(tradingGuardState.availableBalance),
                            0
                        );
                    }
                }

                if (buyPlanningBalance === null) {
                    await releaseClaimedTrade(trade, buyPlanningReason);
                    logger.warn(`${formatTradeRef(trade)} 暂缓入批 reason=${buyPlanningReason}`);
                    continue;
                }

                const evaluation = evaluateDirectBuyIntent({
                    trade,
                    availableBalance: buyPlanningBalance,
                });
                if (evaluation.status === 'SKIP') {
                    await finalizeSingleTradeWithTrail(
                        trade,
                        'SKIPPED',
                        evaluation.reason,
                        evaluation.policyTrail
                    );
                    logger.info(`${formatTradeRef(trade)} 已跳过 reason=${evaluation.reason}`);
                    continue;
                }

                await createBatchFromSingleTrade(trade, {
                    condition: 'buy',
                    requestedUsdc: evaluation.requestedUsdc,
                    sourcePrice: evaluation.sourcePrice,
                    reason: evaluation.reason,
                    policyTrail: evaluation.policyTrail,
                });
                buyPlanningBalance = Math.max(buyPlanningBalance - evaluation.requestedUsdc, 0);
                logger.info(
                    `${formatTradeRef(trade)} 已创建直接买入批次 ` +
                        `requestedUsdc=${formatAmount(evaluation.requestedUsdc)}` +
                        (evaluation.reason ? ` reason=${evaluation.reason}` : '')
                );
                continue;
            }

            await cancelOpenBuyBuffersForAsset(trade);
            await cancelReadyBuyBatchesForAsset(trade);
            await createBatchFromSingleTrade(trade);
            logger.info(`${formatTradeRef(trade)} 已创建直接执行批次`);
        } catch (error) {
            logger.error(`${formatTradeRef(trade)} 入批异常`, error);
            await finalizeRetryableTradeWithLog(trade, '交易入批流程发生未预期异常');
        }
    }
};

const executeReadyBatches = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null
) => {
    const readyBatches = await readReadyBatches();
    for (const batch of readyBatches) {
        const claimed = await claimReadyBatch(batch);
        if (!claimed) {
            continue;
        }

        try {
            const trades = await loadTradesByIds(batch.sourceTradeIds);
            const orderedTrades = sortTradesAsc(trades);
            const latestTrade = orderedTrades.slice(-1)[0];
            if (!latestTrade) {
                await finalizeBatchAndActivities(batch, 'FAILED', '批次缺少关联源交易');
                continue;
            }

            const [myPositionsRaw, tradingGuardState] = await Promise.all([
                fetchData<UserPositionInterface[]>(PROXY_POSITIONS_URL),
                getTradingGuardState(clobClient),
            ]);
            if (!Array.isArray(myPositionsRaw)) {
                await releaseReadyBatch(batch, '代理钱包持仓接口不可用');
                continue;
            }

            if (tradingGuardState.skipReason) {
                await releaseReadyBatch(batch, tradingGuardState.skipReason);
                continue;
            }

            if (tradingGuardState.availableBalance === null) {
                await releaseReadyBatch(batch, '代理钱包可用余额接口不可用');
                continue;
            }

            const myPosition = findPositionForTrade(myPositionsRaw, latestTrade);
            const sourcePositionAfterTrade = {
                size: latestTrade.sourcePositionSizeAfterTrade,
            };
            const condition =
                batch.condition ||
                resolveTradeCondition(latestTrade.side, myPosition, sourcePositionAfterTrade);
            logger.info(
                `${formatBatchRef(batch)} 执行=${condition} ` +
                    `balance=${formatAmount(tradingGuardState.availableBalance)} ` +
                    `proxySize=${formatAmount(myPosition?.size)} ` +
                    `sourceSize=${formatAmount(sourcePositionAfterTrade.size)}`
            );

            const result = await postOrder(
                clobClient,
                marketStream,
                condition,
                myPosition,
                sourcePositionAfterTrade,
                latestTrade,
                tradingGuardState.availableBalance,
                batch.requestedUsdc > 0 || batch.requestedSize > 0
                    ? {
                          requestedUsdc: batch.requestedUsdc > 0 ? batch.requestedUsdc : undefined,
                          requestedSize: batch.requestedSize > 0 ? batch.requestedSize : undefined,
                          sourcePrice: batch.sourcePrice > 0 ? batch.sourcePrice : undefined,
                          note: batch.reason,
                      }
                    : undefined
            );

            if (result.status === 'RETRYABLE_ERROR') {
                await retryBatchExecution(batch, result.reason);
                continue;
            }

            if (result.orderIds.length > 0 || result.transactionHashes.length > 0) {
                await markBatchSubmitted(batch, result);
                logger.info(
                    `${formatBatchRef(batch)} 已提交 orderIds=${result.orderIds.length} ` +
                        `txHashes=${result.transactionHashes.length}`
                );
                await confirmSubmittedBatch(
                    {
                        ...batch,
                        status: 'SUBMITTED',
                        orderIds: result.orderIds,
                        transactionHashes: result.transactionHashes,
                        reason: result.reason,
                        submissionStatus: result.submissionStatus,
                    },
                    userStream
                );
                continue;
            }

            await finalizeBatchAndActivities(
                batch,
                result.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
                result.reason
            );
        } catch (error) {
            logger.error(`${formatBatchRef(batch)} 执行异常`, error);
            await retryBatchExecution(batch, '批次执行链路发生未预期异常');
        }
    }
};

const tradeExecutor = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null
) => {
    logger.info('启动真实跟单');
    const processingCount = await UserActivity.countDocuments({ botStatus: 'PROCESSING' });
    const submittedCount = await UserActivity.countDocuments({ botStatus: 'SUBMITTED' });
    const batchedCount = await UserActivity.countDocuments({ botStatus: 'BATCHED' });
    if (processingCount > 0) {
        logger.warn(`检测到 ${processingCount} 条 PROCESSING 交易，超出租约的记录会自动回收`);
    }
    if (submittedCount > 0) {
        logger.warn(`检测到 ${submittedCount} 条 SUBMITTED 交易/批次，本次启动会优先补偿最终确认`);
    }
    if (batchedCount > 0) {
        logger.warn(`检测到 ${batchedCount} 条 BATCHED 交易，本次启动会继续执行既有批次`);
    }

    while (true) {
        await syncSubmittedTrades(userStream);
        await syncSubmittedBatches(userStream);

        const pendingTrades = await readPendingTrades();
        if (pendingTrades.length > 0) {
            spinner.stop();
            logger.info(`发现 ${pendingTrades.length} 条待入批交易`);
            await processPendingTrades(clobClient, pendingTrades);
        }

        await executeReadyBatches(clobClient, marketStream, userStream);

        if (pendingTrades.length === 0) {
            await spinner.start('等待新交易');
        }

        await sleep(500);
    }
};

export default tradeExecutor;
