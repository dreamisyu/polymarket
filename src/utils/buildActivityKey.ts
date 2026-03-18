import { UserActivityInterface } from '../interfaces/User';

const normalizeText = (value: unknown) => String(value || '').trim();

const normalizeNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(8) : '0';
};

const buildActivityKey = (trade: Partial<UserActivityInterface>) =>
    [
        normalizeText(trade.type).toUpperCase(),
        normalizeText(trade.transactionHash).toLowerCase(),
        normalizeText(trade.asset),
        normalizeText(trade.conditionId),
        normalizeText(trade.outcome),
        normalizeText(trade.side).toUpperCase(),
        normalizeNumber(trade.size),
        normalizeNumber(trade.usdcSize),
        normalizeText(trade.timestamp),
    ].join(':');

export default buildActivityKey;
