import mongoose from 'mongoose';
import type { ExecutionPolicyTrailEntry } from './Execution';

export interface TraceExecutionInterface {
    _id: mongoose.Types.ObjectId;
    traceId: string;
    traceLabel: string;
    sourceWallet: string;
    sourceActivityId?: mongoose.Types.ObjectId;
    sourceActivityIds?: mongoose.Types.ObjectId[];
    sourceActivityKey?: string;
    sourceActivityKeys?: string[];
    sourceTransactionHash: string;
    sourceTransactionHashes?: string[];
    sourceTradeCount?: number;
    sourceTimestamp: number;
    sourceStartedAt?: number;
    sourceEndedAt?: number;
    sourceSide: string;
    executionCondition: string;
    status: 'PROCESSING' | 'FILLED' | 'SKIPPED' | 'FAILED';
    reason: string;
    asset: string;
    conditionId: string;
    marketSlug?: string;
    title: string;
    outcome: string;
    winnerOutcome?: string;
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
    copyIntentBufferId?: mongoose.Types.ObjectId;
    copyExecutionBatchId?: mongoose.Types.ObjectId;
    policyTrail?: ExecutionPolicyTrailEntry[];
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
    marketSlug: string;
    title: string;
    outcome: string;
    outcomeIndex: number;
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

export interface TraceSettlementTaskInterface {
    _id: mongoose.Types.ObjectId;
    traceId: string;
    traceLabel: string;
    sourceWallet: string;
    conditionId: string;
    marketSlug: string;
    title: string;
    status: 'PENDING' | 'PROCESSING' | 'SETTLED' | 'CLOSED';
    reason: string;
    resolvedStatus: string;
    winnerOutcome: string;
    sourceActivityId?: mongoose.Types.ObjectId;
    sourceActivityIds?: mongoose.Types.ObjectId[];
    sourceActivityKeys?: string[];
    sourceTransactionHash: string;
    sourceTransactionHashes?: string[];
    sourceTradeCount?: number;
    sourceTimestamp: number;
    sourceStartedAt?: number;
    sourceEndedAt?: number;
    retryCount: number;
    lastCheckedAt: number;
    nextRetryAt: number;
    claimedAt: number;
    completedAt?: number;
}
