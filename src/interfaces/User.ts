import mongoose from 'mongoose';
import type { ExecutionPolicyTrailEntry } from './Execution';

export type BotExecutionStatus =
    | 'PENDING'
    | 'PROCESSING'
    | 'BUFFERED'
    | 'BATCHED'
    | 'SUBMITTED'
    | 'CONFIRMED'
    | 'COMPLETED'
    | 'SKIPPED'
    | 'FAILED';

export type SnapshotStatus = 'COMPLETE' | 'PARTIAL' | 'STALE';
export type ExecutionIntent = 'EXECUTE' | 'SYNC_ONLY';

export interface UserActivityInterface {
    _id: mongoose.Types.ObjectId;
    activityKey?: string;
    sourceActivityKeys?: string[];
    sourceTransactionHashes?: string[];
    sourceTradeCount?: number;
    sourceStartedAt?: number;
    sourceEndedAt?: number;
    proxyWallet: string;
    timestamp: number;
    conditionId: string;
    type: string;
    size: number;
    usdcSize: number;
    transactionHash: string;
    price: number;
    asset: string;
    side: string;
    outcomeIndex: number;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    name: string;
    pseudonym: string;
    bio: string;
    profileImage: string;
    profileImageOptimized: string;
    bot: boolean;
    botExcutedTime: number;
    botStatus?: BotExecutionStatus;
    botClaimedAt?: number;
    botExecutedAt?: number;
    botLastError?: string;
    botOrderIds?: string[];
    botTransactionHashes?: string[];
    botSubmittedAt?: number;
    botConfirmedAt?: number;
    botMatchedAt?: number;
    botMinedAt?: number;
    botSubmissionStatus?: 'SUBMITTED' | 'MATCHED' | 'MINED' | 'RETRYING' | 'CONFIRMED' | 'FAILED';
    botBufferId?: mongoose.Types.ObjectId;
    botExecutionBatchId?: mongoose.Types.ObjectId;
    botBufferedAt?: number;
    botPolicyTrail?: ExecutionPolicyTrailEntry[];
    executionIntent?: ExecutionIntent;
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourcePositionPriceAfterTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt?: number;
    snapshotStatus?: SnapshotStatus;
    sourceSnapshotReason?: string;
}

export interface UserPositionInterface {
    _id: mongoose.Types.ObjectId;
    proxyWallet: string;
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    cashPnl: number;
    percentPnl: number;
    totalBought: number;
    realizedPnl: number;
    percentRealizedPnl: number;
    curPrice: number;
    redeemable: boolean;
    mergeable: boolean;
    title: string;
    slug: string;
    icon: string;
    eventSlug: string;
    outcome: string;
    outcomeIndex: number;
    oppositeOutcome: string;
    oppositeAsset: string;
    endDate: string;
    negativeRisk: boolean;
}

export interface UserActivitySyncStateInterface {
    _id: mongoose.Types.ObjectId;
    walletAddress: string;
    lastSyncedTimestamp: number;
    lastSyncedActivityKey: string;
    updatedAt: number;
}
