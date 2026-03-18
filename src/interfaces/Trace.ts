import mongoose from 'mongoose';

export interface TraceExecutionInterface {
    _id: mongoose.Types.ObjectId;
    traceId: string;
    traceLabel: string;
    sourceWallet: string;
    sourceActivityId: mongoose.Types.ObjectId;
    sourceActivityKey?: string;
    sourceTransactionHash: string;
    sourceTimestamp: number;
    sourceSide: string;
    executionCondition: string;
    status: 'PROCESSING' | 'FILLED' | 'SKIPPED' | 'FAILED';
    reason: string;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    requestedSize: number;
    executedSize: number;
    requestedUsdc: number;
    executedUsdc: number;
    executionPrice: number;
    cashBefore: number;
    cashAfter: number;
    positionSizeBefore: number;
    positionSizeAfter: number;
    realizedPnlDelta: number;
    realizedPnlTotal: number;
    unrealizedPnlAfter: number;
    totalEquityAfter: number;
    claimedAt?: number;
    completedAt?: number;
}

export interface TracePositionInterface {
    _id: mongoose.Types.ObjectId;
    traceId: string;
    traceLabel: string;
    sourceWallet: string;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    side: string;
    size: number;
    avgPrice: number;
    costBasis: number;
    marketPrice: number;
    marketValue: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalBoughtSize: number;
    totalSoldSize: number;
    totalBoughtUsdc: number;
    totalSoldUsdc: number;
    lastSourceTransactionHash: string;
    lastTradedAt: number;
    closedAt?: number;
}

export interface TracePortfolioInterface {
    _id: mongoose.Types.ObjectId;
    traceId: string;
    traceLabel: string;
    sourceWallet: string;
    initialBalance: number;
    cashBalance: number;
    realizedPnl: number;
    unrealizedPnl: number;
    positionsMarketValue: number;
    totalEquity: number;
    netPnl: number;
    returnPct: number;
    totalExecutions: number;
    filledExecutions: number;
    skippedExecutions: number;
    lastSourceTransactionHash: string;
    lastUpdatedAt: number;
}
