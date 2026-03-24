import type { UserPositionInterface } from '../../../interfaces/User';
import type { PortfolioSnapshot, PositionSnapshot, SourceTradeEvent } from '../../domain/types';
import { normalizeOutcomeLabel } from '../../../utils/polymarketMarketResolution';

const EPSILON = 1e-8;

export const mapUserPosition = (position: UserPositionInterface): PositionSnapshot => ({
    asset: String(position.asset || '').trim(),
    conditionId: String(position.conditionId || '').trim(),
    outcome: String(position.outcome || '').trim(),
    outcomeIndex: Number(position.outcomeIndex) || 0,
    size: Math.max(Number(position.size) || 0, 0),
    avgPrice: Math.max(Number(position.avgPrice) || 0, 0),
    marketPrice: Math.max(Number(position.curPrice) || 0, 0),
    marketValue: Math.max(Number(position.currentValue) || 0, 0),
    costBasis: Math.max(Number(position.initialValue) || 0, 0),
    realizedPnl: Number(position.realizedPnl) || 0,
    redeemable: Boolean(position.redeemable),
    lastUpdatedAt: Date.now(),
});

export const findMatchingPosition = (
    positions: UserPositionInterface[],
    event: SourceTradeEvent
): UserPositionInterface | undefined =>
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

export const buildPortfolioSnapshot = (
    cashBalance: number,
    realizedPnl: number,
    positions: PositionSnapshot[]
): PortfolioSnapshot => {
    const normalizedPositions = positions.filter((position) => position.size > EPSILON);
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
