import type { ConditionPositionSnapshot, PortfolioSnapshot, PositionSnapshot, SourceTradeEvent } from '../../domain';
import type { UserPositionRecord } from '../polymarket/dto';
import { buildConditionOutcomeKey, computeConditionMergeableSize } from '../../utils/conditionMath';
import { normalizeOutcomeLabel } from '../../utils/resolution';

const epsilon = 1e-8;

export const mapUserPosition = (position: UserPositionRecord): PositionSnapshot => ({
    asset: String(position.asset || '').trim(),
    conditionId: String(position.conditionId || '').trim(),
    outcome: String(position.outcome || '').trim(),
    outcomeIndex: Number(position.outcomeIndex) || 0,
    size: Math.max(Number(position.size) || 0, 0),
    avgPrice: Math.max(Number(position.avgPrice) || 0, 0),
    marketPrice: Math.max(Number(position.curPrice) || 0, 0),
    marketValue: Math.max(Number(position.currentValue) || 0, 0),
    costBasis: Math.max(Number(position.avgPrice) || 0, 0) * Math.max(Number(position.size) || 0, 0),
    realizedPnl: Number(position.realizedPnl) || 0,
    redeemable: Boolean(position.redeemable),
    lastUpdatedAt: Date.now(),
});

export const findMatchingPosition = (positions: UserPositionRecord[], event: SourceTradeEvent): UserPositionRecord | undefined =>
    positions.find((position) => position.asset === event.asset) ||
    positions.find(
        (position) =>
            String(position.conditionId || '').trim() === event.conditionId &&
            Number(position.outcomeIndex) === Number(event.outcomeIndex)
    ) ||
    positions.find(
        (position) =>
            String(position.conditionId || '').trim() === event.conditionId &&
            normalizeOutcomeLabel(String(position.outcome || '')) ===
                normalizeOutcomeLabel(String(event.outcome || ''))
    );

export const buildConditionPositionSnapshot = (positions: PositionSnapshot[], conditionId: string): ConditionPositionSnapshot => {
    const targetPositions = positions.filter((position) => position.conditionId === conditionId && position.size > epsilon);
    const sizeByOutcome = new Map<string, number>();
    const outcomeKeys: string[] = [];

    for (const position of targetPositions) {
        const outcomeKey = buildConditionOutcomeKey(position);
        if (!outcomeKey) {
            continue;
        }

        outcomeKeys.push(outcomeKey);
        sizeByOutcome.set(outcomeKey, Math.max(Number(position.size) || 0, 0));
    }

    return {
        conditionId,
        positions: targetPositions,
        mergeableSize: computeConditionMergeableSize(outcomeKeys, sizeByOutcome),
    };
};

export const buildPortfolioSnapshot = (
    cashBalance: number,
    realizedPnl: number,
    positions: PositionSnapshot[]
): PortfolioSnapshot => {
    const normalizedPositions = positions.filter((position) => position.size > epsilon);
    const positionsMarketValue = normalizedPositions.reduce(
        (sum, position) => sum + Math.max(Number(position.marketValue) || 0, 0),
        0
    );

    return {
        cashBalance,
        realizedPnl,
        positionsMarketValue,
        totalEquity: cashBalance + positionsMarketValue,
        activeExposureUsdc: positionsMarketValue,
        openPositionCount: normalizedPositions.length,
        positions: normalizedPositions,
    };
};
