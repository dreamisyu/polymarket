import mongoose from 'mongoose';

export type ExecutionPolicyAction = 'PASS' | 'ADJUST' | 'DEFER' | 'SKIP' | 'RETRY';
export type CopyIntentBufferState = 'OPEN' | 'FLUSHING' | 'CLOSED' | 'SKIPPED';
export type ExecutionKind = 'TRADE' | 'MERGE' | 'REDEEM';
export type BuySizingMode =
    | 'ratio'
    | 'first_entry_ticket'
    | 'signal_fixed_ticket'
    | 'condition_pair_overlay';
export type CopyExecutionBatchStatus =
    | 'READY'
    | 'PROCESSING'
    | 'SUBMITTED'
    | 'PENDING_CONFIRMATION'
    | 'TIMEOUT'
    | 'CONFIRMED'
    | 'SKIPPED'
    | 'FAILED';

export interface ExecutionPolicyTrailEntry {
    policyId: string;
    action: ExecutionPolicyAction;
    reason: string;
    timestamp: number;
}

export interface CopyIntentBufferInterface {
    _id: mongoose.Types.ObjectId;
    sourceWallet: string;
    bufferKey: string;
    state: CopyIntentBufferState;
    condition: string;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    side: string;
    sourceTradeIds: mongoose.Types.ObjectId[];
    sourceActivityKeys: string[];
    sourceTransactionHashes: string[];
    sourceTradeCount: number;
    sourceStartedAt: number;
    sourceEndedAt: number;
    requestedUsdc: number;
    sourceUsdcTotal?: number;
    sourcePrice: number;
    flushAfter: number;
    expireAt: number;
    bufferWindowMs?: number;
    sizingMode?: BuySizingMode;
    claimedAt?: number;
    reason?: string;
    policyTrail?: ExecutionPolicyTrailEntry[];
    completedAt?: number;
}

export interface CopyExecutionBatchInterface {
    _id: mongoose.Types.ObjectId;
    sourceWallet: string;
    bufferId?: mongoose.Types.ObjectId;
    status: CopyExecutionBatchStatus;
    executionKind?: ExecutionKind;
    condition: string;
    asset: string;
    conditionId: string;
    title: string;
    outcome: string;
    side: string;
    sourceTradeIds: mongoose.Types.ObjectId[];
    sourceActivityKeys: string[];
    sourceTransactionHashes: string[];
    sourceTradeCount: number;
    sourceStartedAt: number;
    sourceEndedAt: number;
    sourcePrice: number;
    requestedUsdc: number;
    requestedSize: number;
    orderIds: string[];
    transactionHashes: string[];
    policyTrail?: ExecutionPolicyTrailEntry[];
    retryCount: number;
    claimedAt?: number;
    submittedAt?: number;
    confirmedAt?: number;
    completedAt?: number;
    localPositionSizeBefore?: number;
    localConditionMergeableSizeBefore?: number;
    lastConfirmationSource?: 'user_stream' | 'chain' | 'reconcile';
    reason?: string;
    submissionStatus?: 'SUBMITTED' | 'MATCHED' | 'MINED' | 'RETRYING' | 'CONFIRMED' | 'FAILED';
}
