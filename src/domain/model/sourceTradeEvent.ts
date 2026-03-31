import mongoose from 'mongoose';
import type {
    ExecutionIntent,
    SnapshotStatus,
    SourceEventStatus,
    TradeAction,
} from '@domain/value-objects/enums';

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
    executionIntent: ExecutionIntent;
    sourceBalanceAfterTrade?: number;
    sourceBalanceBeforeTrade?: number;
    sourcePositionSizeAfterTrade?: number;
    sourcePositionSizeBeforeTrade?: number;
    sourceConditionMergeableSizeAfterTrade?: number;
    sourceConditionMergeableSizeBeforeTrade?: number;
    sourceSnapshotCapturedAt?: number;
    snapshotStatus?: SnapshotStatus;
    sourceSnapshotReason?: string;
    status?: SourceEventStatus;
    claimedAt?: number;
    processedAt?: number;
    nextRetryAt?: number;
    attemptCount?: number;
    lastError?: string;
    raw?: Record<string, unknown>;
}
