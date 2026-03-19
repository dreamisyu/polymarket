import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import ClobMarketStream from './clobMarketStream';
import ClobUserStream, { UserChannelStatusUpdate } from './clobUserStream';
import LiveSettlementReclaimer from './liveSettlementReclaimer';
import confirmTransactionHashes from '../utils/confirmTransactionHashes';
import fetchData from '../utils/fetchData';
import getTradingGuardState from '../utils/getTradingGuardState';
import postOrder, { PostOrderResult } from '../utils/postOrder';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import spinner from '../utils/spinner';
import createLogger from '../utils/logger';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROCESSING_LEASE_MS = ENV.PROCESSING_LEASE_MS;
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}&sizeThreshold=0`;
const logger = createLogger('live');

const UserActivity = getUserActivityModel(USER_ADDRESS);

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
    positions.find((position) => position.conditionId === trade.conditionId);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mergeReasons = (...reasons: string[]) =>
    [...new Set(reasons.map((reason) => String(reason || '').trim()))].filter(Boolean).join('；');
const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const formatAmount = (value: unknown) => toSafeNumber(value).toFixed(4);
const formatTradeRef = (trade: Pick<UserActivityInterface, 'transactionHash' | 'asset' | 'side'>) =>
    `tx=${trade.transactionHash} side=${String(trade.side || '').toUpperCase()} asset=${trade.asset}`;
const formatTerminalStatus = (status: 'CONFIRMED' | 'SKIPPED' | 'FAILED') =>
    status === 'CONFIRMED' ? '已确认' : status === 'SKIPPED' ? '已跳过' : '已失败';

const buildLeaseCutoff = () => Date.now() - PROCESSING_LEASE_MS;

const buildClaimableFilter = (leaseCutoff: number) => ({
    $or: [
        { botClaimedAt: { $exists: false } },
        { botClaimedAt: 0 },
        { botClaimedAt: { $lt: leaseCutoff } },
    ],
});

const buildReclaimableProcessingFilter = (leaseCutoff: number) => ({
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
                    buildReclaimableProcessingFilter(buildLeaseCutoff()),
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
            buildClaimableFilter(buildLeaseCutoff()),
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

const claimTrade = async (trade: UserActivityInterface) => {
    const result = await UserActivity.updateOne(
        {
            _id: trade._id,
            bot: { $ne: true },
            $or: [
                { botStatus: { $exists: false } },
                { botStatus: 'PENDING' },
                buildReclaimableProcessingFilter(buildLeaseCutoff()),
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
            ...buildClaimableFilter(buildLeaseCutoff()),
        },
        {
            $set: {
                botClaimedAt: Date.now(),
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
                onStatus: async (update) => {
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

const doTrading = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null,
    trades: UserActivityInterface[]
) => {
    for (const trade of trades) {
        const claimed = await claimTrade(trade);
        if (!claimed) {
            continue;
        }

        try {
            const [myPositionsRaw, tradingGuardState] = await Promise.all([
                fetchData<UserPositionInterface[]>(PROXY_POSITIONS_URL),
                getTradingGuardState(clobClient),
            ]);
            if (!Array.isArray(myPositionsRaw)) {
                await finalizeRetryableTradeWithLog(trade, '代理钱包持仓接口不可用');
                continue;
            }

            if (tradingGuardState.skipReason) {
                await finalizeTerminalTradeWithLog(trade, 'SKIPPED', tradingGuardState.skipReason);
                continue;
            }

            if (tradingGuardState.availableBalance === null) {
                await finalizeRetryableTradeWithLog(trade, '代理钱包可用余额接口不可用');
                continue;
            }

            if (!Number.isFinite(trade.sourceBalanceAfterTrade)) {
                await finalizeRetryableTradeWithLog(trade, '缺少源账户余额快照');
                continue;
            }

            if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
                await finalizeRetryableTradeWithLog(trade, '缺少源账户持仓快照');
                continue;
            }

            if (trade.snapshotStatus && trade.snapshotStatus !== 'COMPLETE') {
                await finalizeTerminalTradeWithLog(
                    trade,
                    'SKIPPED',
                    trade.sourceSnapshotReason ||
                        `源账户快照状态为 ${trade.snapshotStatus}，已跳过真实执行`
                );
                continue;
            }

            const myPosition = findPositionForTrade(myPositionsRaw, trade);
            const sourcePositionAfterTrade = {
                size: trade.sourcePositionSizeAfterTrade,
            };
            const condition = resolveTradeCondition(
                trade.side,
                myPosition,
                sourcePositionAfterTrade
            );
            logger.info(
                `${formatTradeRef(trade)} 执行=${condition} ` +
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
                trade,
                tradingGuardState.availableBalance,
                trade.sourceBalanceAfterTrade
            );

            if (result.status === 'RETRYABLE_ERROR') {
                await finalizeRetryableTradeWithLog(trade, result.reason);
                continue;
            }

            if (result.orderIds.length > 0 || result.transactionHashes.length > 0) {
                await markTradeSubmitted(trade, result);
                logger.info(
                    `${formatTradeRef(trade)} 已提交 orderIds=${result.orderIds.length} ` +
                        `txHashes=${result.transactionHashes.length}`
                );
                await confirmSubmittedTrade(
                    {
                        ...trade,
                        botStatus: 'SUBMITTED',
                        botOrderIds: result.orderIds,
                        botTransactionHashes: result.transactionHashes,
                        botSubmittedAt: Date.now(),
                        botSubmissionStatus: result.submissionStatus,
                        botLastError: result.reason,
                    },
                    userStream
                );
                continue;
            }

            await finalizeTerminalTradeWithLog(
                trade,
                result.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
                result.reason
            );
        } catch (error) {
            logger.error(`${formatTradeRef(trade)} 执行异常`, error);
            await finalizeRetryableTradeWithLog(trade, '执行链路发生未预期异常');
        }
    }
};

const tradeExecutor = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null
) => {
    logger.info('启动真实跟单');
    const settlementReclaimer = new LiveSettlementReclaimer();
    const processingCount = await UserActivity.countDocuments({ botStatus: 'PROCESSING' });
    const submittedCount = await UserActivity.countDocuments({ botStatus: 'SUBMITTED' });
    if (processingCount > 0) {
        logger.warn(`检测到 ${processingCount} 条 PROCESSING 交易，超出租约的记录会自动回收`);
    }
    if (submittedCount > 0) {
        logger.warn(`检测到 ${submittedCount} 条 SUBMITTED 交易，本次启动会优先补偿最终确认`);
    }

    while (true) {
        await syncSubmittedTrades(userStream);
        await settlementReclaimer.runDue();

        const pendingTrades = await readPendingTrades();
        if (pendingTrades.length > 0) {
            spinner.stop();
            logger.info(`发现 ${pendingTrades.length} 条待处理交易`);
            await doTrading(clobClient, marketStream, userStream, pendingTrades);
        } else {
            await spinner.start('等待新交易');
        }

        await sleep(1000);
    }
};

export default tradeExecutor;
