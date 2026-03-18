import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder, { PostOrderResult } from '../utils/postOrder';
import resolveTradeCondition from '../utils/resolveTradeCondition';
import spinner from '../utils/spinner';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

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

const readPendingTrades = async () =>
    (await UserActivity.find({
        $and: [
            { type: 'TRADE' },
            { transactionHash: { $exists: true, $ne: '' } },
            { bot: { $ne: true } },
            {
                $or: [{ botStatus: { $exists: false } }, { botStatus: 'PENDING' }],
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

const claimTrade = async (trade: UserActivityInterface) => {
    const result = await UserActivity.updateOne(
        {
            _id: trade._id,
            bot: { $ne: true },
            $or: [{ botStatus: { $exists: false } }, { botStatus: 'PENDING' }],
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

const finalizeTrade = async (trade: UserActivityInterface, result: PostOrderResult) => {
    if (result.status === 'RETRYABLE_ERROR') {
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
                        botLastError: result.reason,
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
                    botLastError: result.reason,
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
                bot: true,
                botStatus:
                    result.status === 'COMPLETED'
                        ? 'COMPLETED'
                        : result.status === 'SKIPPED'
                          ? 'SKIPPED'
                          : 'FAILED',
                botExecutedAt: Date.now(),
                botClaimedAt: 0,
                botLastError: result.reason,
            },
        }
    );
};

const buildRetryableResult = (reason: string): PostOrderResult => ({
    status: 'RETRYABLE_ERROR',
    reason,
});

const doTrading = async (clobClient: ClobClient, trades: UserActivityInterface[]) => {
    for (const trade of trades) {
        const claimed = await claimTrade(trade);
        if (!claimed) {
            continue;
        }

        try {
            console.log('待复制交易:', trade);

            const myPositionsRaw = await fetchData<UserPositionInterface[]>(
                `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
            );
            if (!Array.isArray(myPositionsRaw)) {
                await finalizeTrade(trade, buildRetryableResult('代理钱包持仓接口不可用'));
                continue;
            }

            const myBalance = await getMyBalance(PROXY_WALLET);
            if (myBalance === null) {
                await finalizeTrade(trade, buildRetryableResult('代理钱包余额接口不可用'));
                continue;
            }

            if (!Number.isFinite(trade.sourceBalanceAfterTrade)) {
                await finalizeTrade(trade, buildRetryableResult('缺少源账户余额快照'));
                continue;
            }

            if (!Number.isFinite(trade.sourcePositionSizeAfterTrade)) {
                await finalizeTrade(trade, buildRetryableResult('缺少源账户持仓快照'));
                continue;
            }

            const myPosition = findPositionForTrade(myPositionsRaw, trade);
            const sourcePositionAfterTrade = {
                size: trade.sourcePositionSizeAfterTrade,
            };

            console.log('代理钱包当前余额:', myBalance);
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
                condition,
                myPosition,
                sourcePositionAfterTrade,
                trade,
                myBalance,
                trade.sourceBalanceAfterTrade
            );

            await finalizeTrade(trade, result);
            console.log(`交易 ${trade.transactionHash} 处理完成，状态 ${result.status}`);
        } catch (error) {
            console.error(`处理交易 ${trade.transactionHash} 时发生错误:`, error);
            await finalizeTrade(trade, buildRetryableResult('执行链路发生未预期异常'));
        }
    }
};

const tradeExecutor = async (clobClient: ClobClient) => {
    console.log('开始执行真实跟单');
    const processingCount = await UserActivity.countDocuments({ botStatus: 'PROCESSING' });
    if (processingCount > 0) {
        console.warn(
            `检测到 ${processingCount} 条仍处于 PROCESSING 的交易。` +
                `为避免真实重复下单，这些记录已保持锁定，请人工确认。`
        );
    }

    while (true) {
        const pendingTrades = await readPendingTrades();
        if (pendingTrades.length > 0) {
            console.log(`💥 发现 ${pendingTrades.length} 条待处理交易 💥`);
            spinner.stop();
            await doTrading(clobClient, pendingTrades);
        } else {
            await spinner.start('等待新交易');
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
};

export default tradeExecutor;
