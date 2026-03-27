export interface PositionSnapshot {
    asset: string;
    conditionId: string;
    outcome: string;
    outcomeIndex: number;
    size: number;
    avgPrice: number;
    marketPrice: number;
    marketValue: number;
    costBasis: number;
    realizedPnl: number;
    redeemable?: boolean;
    lastUpdatedAt?: number;
}

export interface ConditionPositionSnapshot {
    conditionId: string;
    positions: PositionSnapshot[];
    mergeableSize: number;
}

export interface PortfolioSnapshot {
    cashBalance: number;
    realizedPnl: number;
    positionsMarketValue: number;
    totalEquity: number;
    activeExposureUsdc: number;
    openPositionCount: number;
    positions: PositionSnapshot[];
}
