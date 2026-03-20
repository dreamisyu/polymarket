import { UserActivityInterface } from '../interfaces/User';

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const uniqueStrings = (values: string[]) => [
    ...new Set(values.map((value) => String(value || '').trim()).filter(Boolean)),
];

export const getSourceActivityKeys = (trade: Partial<UserActivityInterface>) =>
    uniqueStrings([...(trade.sourceActivityKeys || []), String(trade.activityKey || '').trim()]);

export const getSourceTransactionHashes = (trade: Partial<UserActivityInterface>) =>
    uniqueStrings([
        ...(trade.sourceTransactionHashes || []),
        String(trade.transactionHash || '').trim(),
    ]);

export const getSourceTradeCount = (trade: Partial<UserActivityInterface>) =>
    Math.max(toSafeNumber(trade.sourceTradeCount, 1), 1);

export const getSourceStartedAt = (trade: Partial<UserActivityInterface>) =>
    Math.max(toSafeNumber(trade.sourceStartedAt, toSafeNumber(trade.timestamp)), 0);

export const getSourceEndedAt = (trade: Partial<UserActivityInterface>) =>
    Math.max(
        toSafeNumber(trade.sourceEndedAt, toSafeNumber(trade.timestamp, getSourceStartedAt(trade))),
        0
    );

export const flattenSourceActivityKeys = (trades: Array<Partial<UserActivityInterface>>) =>
    uniqueStrings(trades.flatMap((trade) => getSourceActivityKeys(trade)));

export const flattenSourceTransactionHashes = (trades: Array<Partial<UserActivityInterface>>) =>
    uniqueStrings(trades.flatMap((trade) => getSourceTransactionHashes(trade)));

export const sumSourceTradeCount = (trades: Array<Partial<UserActivityInterface>>) =>
    trades.reduce((sum, trade) => sum + getSourceTradeCount(trade), 0);

export const getSourceWindowStartedAt = (trades: Array<Partial<UserActivityInterface>>) => {
    const startedAt = trades.map((trade) => getSourceStartedAt(trade)).filter((value) => value > 0);

    return startedAt.length > 0 ? Math.min(...startedAt) : 0;
};

export const getSourceWindowEndedAt = (trades: Array<Partial<UserActivityInterface>>) => {
    const endedAt = trades.map((trade) => getSourceEndedAt(trade)).filter((value) => value > 0);

    return endedAt.length > 0 ? Math.max(...endedAt) : 0;
};
