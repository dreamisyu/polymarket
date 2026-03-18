import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import ClobMarketStream from './clobMarketStream';
import ClobUserStream, { UserChannelStatusUpdate } from './clobUserStream';
import confirmTransactionHashes from '../utils/confirmTransactionHashes';
import fetchData from '../utils/fetchData';
import getTradingGuardState from '../utils/getTradingGuardState';
import postOrder, { PostOrderResult } from '../utils/postOrder';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import spinner from '../utils/spinner';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROCESSING_LEASE_MS = ENV.PROCESSING_LEASE_MS;
const PROXY_POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}&sizeThreshold=0`;

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
            await releaseSubmittedTrade(
                trade,
                mergeReasons(trade.botLastError || '', normalizedConfirmation.reason)
            );
            return;
        }

        if (normalizedConfirmation.confirmationStatus === 'FAILED') {
            await finalizeTerminalTrade(
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
        await finalizeTerminalTrade(
            trade,
            finalStatus,
            normalizedConfirmation.reason,
            normalizedConfirmation.confirmedAt
        );
    } catch (error) {
        console.error(`确认交易 ${trade.transactionHash} 时发生错误:`, error);
        await releaseSubmittedTrade(trade, 'User Channel 确认查询失败，稍后重试');
    }
};

const syncSubmittedTrades = async (userStream: ClobUserStream | null) => {
    const submittedTrades = await readSubmittedTrades();
    if (submittedTrades.length === 0) {
        return;
    }

    console.log(`检测到 ${submittedTrades.length} 条等待最终确认的交易，开始补偿确认`);

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
            console.log('待复制交易:', trade);

            const [myPositionsRaw, tradingGuardState] = await Promise.all([
                fetchData<UserPositionInterface[]>(PROXY_POSITIONS_URL),
                getTradingGuardState(clobClient),
            ]);
            if (!Array.isArray(myPositionsRaw)) {
                await finalizeRetryableTrade(trade, '代理钱包持仓接口不可用');
                continue;
            }

            if (tradingGuardState.skipReason) {
                await finalizeTerminalTrade(trade, 'SKIPPED', tradingGuardState.skipReason);
                continue;
            }

            if (tradingGuardState.availableBalance === null) {
                await finalizeRetryableTrade(trade, '代理钱包可用余额接口不可用');
                continue;
            }

            if (!Number.isFinite(trade.sourceBalanceAfterTrade)) {
                await finalizeRetryableTrade(trade, '缺少源账户余额快照');
                continue;
            }

            if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
                await finalizeRetryableTrade(trade, '缺少源账户持仓快照');
                continue;
            }

            if (trade.snapshotStatus && trade.snapshotStatus !== 'COMPLETE') {
                await finalizeTerminalTrade(
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

            console.log('代理钱包当前可用余额:', tradingGuardState.availableBalance);
            console.log('代理钱包当前持仓:', myPosition);
            console.log('源账户成交后余额快照:', trade.sourceBalanceAfterTrade);
            console.log('源账户成交后持仓快照:', sourcePositionAfterTrade);

            const condition = resolveTradeCondition(
                trade.side,
                myPosition,
                sourcePositionAfterTrade
            );
            console.log(`交易 ${trade.transactionHash} 的执行条件为: ${condition}`);

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
                await finalizeRetryableTrade(trade, result.reason);
                continue;
            }

            if (result.orderIds.length > 0 || result.transactionHashes.length > 0) {
                await markTradeSubmitted(trade, result);
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
                console.log(`交易 ${trade.transactionHash} 已提交，等待 User Channel 最终确认`);
                continue;
            }

            await finalizeTerminalTrade(
                trade,
                result.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
                result.reason
            );
            console.log(`交易 ${trade.transactionHash} 处理完成，状态 ${result.status}`);
        } catch (error) {
            console.error(`处理交易 ${trade.transactionHash} 时发生错误:`, error);
            await finalizeRetryableTrade(trade, '执行链路发生未预期异常');
        }
    }
};

const tradeExecutor = async (
    clobClient: ClobClient,
    marketStream: ClobMarketStream,
    userStream: ClobUserStream | null
) => {
    console.log('开始执行真实跟单');
    const processingCount = await UserActivity.countDocuments({ botStatus: 'PROCESSING' });
    const submittedCount = await UserActivity.countDocuments({ botStatus: 'SUBMITTED' });
    if (processingCount > 0) {
        console.warn(
            `检测到 ${processingCount} 条仍处于 PROCESSING 的交易。` +
                `超出租约的记录会自动回收并重新执行。`
        );
    }
    if (submittedCount > 0) {
        console.warn(
            `检测到 ${submittedCount} 条仍处于 SUBMITTED 的交易。` +
                `本次启动会优先补偿 User Channel 最终确认。`
        );
    }

    while (true) {
        await syncSubmittedTrades(userStream);

        const pendingTrades = await readPendingTrades();
        if (pendingTrades.length > 0) {
            console.log(`💥 发现 ${pendingTrades.length} 条待处理交易 💥`);
            spinner.stop();
            await doTrading(clobClient, marketStream, userStream, pendingTrades);
        } else {
            await spinner.start('等待新交易');
        }

        await sleep(1000);
    }
};

export default tradeExecutor;
