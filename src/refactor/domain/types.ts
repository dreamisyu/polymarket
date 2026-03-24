import mongoose from 'mongoose';

export type RunMode = 'live' | 'paper';
export type StrategyKind = 'signal' | 'fixed_amount' | 'proportional';
export type WorkflowKind = 'monitor' | 'copytrade' | 'settlement';
export type SourceEventStatus = 'pending' | 'processing' | 'retry' | 'confirmed' | 'skipped' | 'failed';
export type WorkflowExecutionStatus =
    | 'ready'
    | 'submitted'
    | 'confirmed'
    | 'skipped'
    | 'retry'
    | 'failed';
export type TradeAction = 'buy' | 'sell' | 'merge' | 'redeem';

export interface SourceTradeEvent {
    _id?: mongoose.Types.ObjectId;
    sourceWallet: string;
    activityKey: string;
    timestamp: number;
    type: string;
    side: string;
    action: TradeAction;
    transactionHash: string;
    conditionId: string;
    asset: string;
    outcome: string;
    outcomeIndex: number;
    title: string;
    slug: string;
    eventSlug: string;
    price: number;
    size: number;
    usdcSize: number;
    executionIntent: 'EXECUTE' | 'SYNC_ONLY';
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt?: number;
    snapshotStatus?: 'COMPLETE' | 'PARTIAL' | 'STALE';
    sourceSnapshotReason?: string;
    status?: SourceEventStatus;
    claimedAt?: number;
    processedAt?: number;
    nextRetryAt?: number;
    attemptCount?: number;
    lastError?: string;
    raw?: Record<string, unknown>;
}

export interface StrategySizingDecision {
    status: 'ready' | 'skip';
    requestedUsdc?: number;
    requestedSize?: number;
    reason: string;
    note?: string;
    ticketTier?: 'weak' | 'normal' | 'strong';
}

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

export interface PortfolioSnapshot {
    cashBalance: number;
    realizedPnl: number;
    positionsMarketValue: number;
    totalEquity: number;
    activeExposureUsdc: number;
    openPositionCount: number;
    positions: PositionSnapshot[];
}

export interface TradeExecutionRequest {
    sourceEvent: SourceTradeEvent;
    requestedUsdc?: number;
    requestedSize?: number;
    note?: string;
}

export interface TradeExecutionResult {
    status: WorkflowExecutionStatus;
    reason: string;
    requestedUsdc: number;
    requestedSize: number;
    executedUsdc: number;
    executedSize: number;
    executionPrice: number;
    orderIds: string[];
    transactionHashes: string[];
    matchedAt?: number;
    minedAt?: number;
    confirmedAt?: number;
    metadata?: Record<string, unknown>;
}

export interface WorkflowExecutionRecord {
    _id?: mongoose.Types.ObjectId;
    workflowId: string;
    strategyKind: StrategyKind;
    runMode: RunMode;
    sourceEventId: mongoose.Types.ObjectId;
    sourceWallet: string;
    activityKey: string;
    conditionId: string;
    asset: string;
    side: string;
    action: TradeAction;
    status: WorkflowExecutionStatus;
    requestedUsdc: number;
    requestedSize: number;
    executedUsdc: number;
    executedSize: number;
    executionPrice: number;
    orderIds: string[];
    transactionHashes: string[];
    reason: string;
    note?: string;
    policyTrail?: string[];
    matchedAt?: number;
    minedAt?: number;
    confirmedAt?: number;
    createdAt?: number;
    updatedAt?: number;
}

export interface SettlementTask {
    _id?: mongoose.Types.ObjectId;
    conditionId: string;
    title: string;
    marketSlug: string;
    status: 'pending' | 'processing' | 'settled' | 'closed';
    reason: string;
    retryCount: number;
    lastCheckedAt: number;
    claimedAt: number;
    nextRetryAt: number;
    winnerOutcome?: string;
}

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    headNodeId: string;
}
