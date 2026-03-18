import { ENV } from '../config/env';
import {
    BotExecutionStatus,
    UserActivityInterface,
    UserPositionInterface,
} from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import buildTradeSnapshots, { TradeSnapshotFields } from '../utils/buildTradeSnapshots';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';

const USER_ADDRESS = ENV.USER_ADDRESS;
const TOO_OLD_TIMESTAMP = ENV.TOO_OLD_TIMESTAMP;
const FETCH_INTERVAL = ENV.FETCH_INTERVAL;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;

if (!USER_ADDRESS) {
    throw new Error('USER_ADDRESS is not defined');
}

const UserActivity = getUserActivityModel(USER_ADDRESS);

const normalizeTimestamp = (rawTimestamp: number): number | null => {
    if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
        return null;
    }

    const parsedTimestamp = Math.trunc(rawTimestamp);
    return parsedTimestamp < MILLISECOND_TIMESTAMP_THRESHOLD
        ? parsedTimestamp * 1000
        : parsedTimestamp;
};

const normalizeTrade = (trade: UserActivityInterface): UserActivityInterface | null => {
    const baseTrade =
        typeof (trade as { toObject?: () => UserActivityInterface }).toObject === 'function'
            ? (trade as { toObject: () => UserActivityInterface }).toObject()
            : trade;
    const normalizedTimestamp = normalizeTimestamp(Number(trade.timestamp));
    const transactionHash = String(trade.transactionHash || '').trim();

    if (normalizedTimestamp === null) {
        console.warn(`Skip trade with invalid timestamp: ${transactionHash || 'unknown-hash'}`);
        return null;
    }

    if (!transactionHash) {
        console.warn(`Skip trade without transaction hash at timestamp ${normalizedTimestamp}`);
        return null;
    }

    return {
        ...baseTrade,
        transactionHash,
        timestamp: normalizedTimestamp,
    };
};

const getDefaultBotStatus = (trade: UserActivityInterface): BotExecutionStatus =>
    trade.bot ? 'COMPLETED' : 'PENDING';

const hasSnapshot = (trade: UserActivityInterface) =>
    Number.isFinite(trade.sourceBalanceAfterTrade) &&
    Number.isFinite(trade.sourceBalanceBeforeTrade) &&
    Number.isFinite(trade.sourcePositionSizeAfterTrade) &&
    Number.isFinite(trade.sourcePositionSizeBeforeTrade);

const mergeTradesByHash = (trades: UserActivityInterface[]) => {
    const tradeMap = new Map<string, UserActivityInterface>();

    for (const trade of trades) {
        if (!trade.transactionHash) {
            continue;
        }

        tradeMap.set(trade.transactionHash, trade);
    }

    return [...tradeMap.values()];
};

const prepareSnapshotData = (
    trade: UserActivityInterface,
    snapshots: Map<string, TradeSnapshotFields>,
    capturedAt: number
) => ({
    ...(snapshots.get(trade.transactionHash) || {
        sourceBalanceAfterTrade: 0,
        sourceBalanceBeforeTrade: 0,
        sourcePositionSizeAfterTrade: 0,
        sourcePositionSizeBeforeTrade: 0,
        sourcePositionPriceAfterTrade: Math.max(Number(trade.price) || 0, 0),
        sourceSnapshotCapturedAt: capturedAt,
    }),
});

const syncStoredTrades = async (
    storedTrades: UserActivityInterface[],
    snapshots: Map<string, TradeSnapshotFields>
) => {
    const bulkOps = storedTrades
        .map((trade) => {
            const normalizedTimestamp = normalizeTimestamp(Number(trade.timestamp));
            const nextStatus = trade.botStatus || getDefaultBotStatus(trade);
            const updateSet: Record<string, unknown> = {};

            if (normalizedTimestamp !== null && normalizedTimestamp !== trade.timestamp) {
                updateSet.timestamp = normalizedTimestamp;
            }

            if (!trade.botStatus) {
                updateSet.botStatus = nextStatus;
            }

            if (!hasSnapshot(trade) && trade.transactionHash) {
                Object.assign(updateSet, prepareSnapshotData(trade, snapshots, Date.now()));
            }

            if (Object.keys(updateSet).length === 0) {
                return null;
            }

            return {
                updateOne: {
                    filter: { _id: trade._id },
                    update: { $set: updateSet },
                },
            };
        })
        .filter((operation): operation is NonNullable<typeof operation> => operation !== null);

    if (bulkOps.length > 0) {
        await UserActivity.bulkWrite(bulkOps);
    }
};

const fetchTradeData = async () => {
    try {
        const activitiesRaw = await fetchData<UserActivityInterface[]>(
            `https://data-api.polymarket.com/activity?user=${USER_ADDRESS}`
        );

        if (!Array.isArray(activitiesRaw)) {
            console.warn('活动接口暂不可用，跳过本轮抓取');
            return;
        }

        if (activitiesRaw.length === 0) {
            console.warn('活动接口返回为空');
            return;
        }

        const normalizedTrades = activitiesRaw
            .filter((activity) => activity.type === 'TRADE')
            .map(normalizeTrade)
            .filter((trade): trade is UserActivityInterface => trade !== null);

        if (normalizedTrades.length === 0) {
            return;
        }

        const currentPositionsRaw = await fetchData<UserPositionInterface[]>(
            `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
        );
        if (!Array.isArray(currentPositionsRaw)) {
            console.warn('源账户持仓接口不可用，跳过本轮以避免写入不完整快照');
            return;
        }

        const currentBalance = await getMyBalance(USER_ADDRESS);
        if (currentBalance === null) {
            console.warn('源账户余额接口不可用，跳过本轮以避免写入不完整快照');
            return;
        }

        const storedTrades = (await UserActivity.find({
            type: 'TRADE',
        }).exec()) as UserActivityInterface[];
        const normalizedStoredTrades = storedTrades
            .map(normalizeTrade)
            .filter((trade): trade is UserActivityInterface => trade !== null);
        const cutoffTimestamp = Date.now() - TOO_OLD_TIMESTAMP * 60 * 60 * 1000;
        const storedHashes = new Set(normalizedStoredTrades.map((trade) => trade.transactionHash));
        const newTrades = normalizedTrades.filter((trade) => {
            const isNew = !storedHashes.has(trade.transactionHash);
            const isRecent = trade.timestamp >= cutoffTimestamp;
            return isNew && isRecent;
        });
        const snapshotCapturedAt = Date.now();
        const snapshotSourceTrades = mergeTradesByHash([...normalizedStoredTrades, ...newTrades]);
        const snapshotMap = buildTradeSnapshots(
            snapshotSourceTrades,
            currentPositionsRaw,
            currentBalance,
            snapshotCapturedAt
        );

        await syncStoredTrades(normalizedStoredTrades, snapshotMap);

        if (newTrades.length === 0) {
            return;
        }

        console.log(`发现 ${newTrades.length} 条待处理的新交易`);

        for (const trade of newTrades) {
            await UserActivity.create({
                ...trade,
                proxyWallet: USER_ADDRESS,
                bot: false,
                botExcutedTime: 0,
                botStatus: 'PENDING',
                botClaimedAt: 0,
                botExecutedAt: 0,
                botLastError: '',
                ...prepareSnapshotData(trade, snapshotMap, snapshotCapturedAt),
            });
            console.log(`已保存新交易: ${trade.transactionHash}`);
        }
    } catch (error) {
        console.error('抓取交易数据时发生错误:', error);
    }
};

const tradeMonitor = async () => {
    console.log('交易监控已启动，轮询间隔', FETCH_INTERVAL, '秒');

    while (true) {
        await fetchTradeData();
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }
};

export default tradeMonitor;
