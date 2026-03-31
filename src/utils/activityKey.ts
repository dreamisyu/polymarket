import type { SourceActivityRecord } from '@infrastructure/polymarket/dto';
import { toSafeNumber } from '@shared/math';

const normalizeText = (value: unknown) => String(value || '').trim();
const normalizeNumber = (value: unknown) => toSafeNumber(value).toFixed(8);

export const buildActivityKey = (trade: Partial<SourceActivityRecord>) =>
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
