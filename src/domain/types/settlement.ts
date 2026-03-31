import mongoose from 'mongoose';
import type { SettlementTaskStatus } from '@domain/value-objects/enums';
import type { PositionSnapshot } from '@domain/types/portfolio';

export interface SettlementTask {
    _id?: mongoose.Types.ObjectId;
    conditionId: string;
    title: string;
    marketSlug: string;
    status: SettlementTaskStatus;
    reason: string;
    retryCount: number;
    lastCheckedAt: number;
    claimedAt: number;
    nextRetryAt: number;
    winnerOutcome?: string;
}

export interface SettlementRedeemRequest {
    conditionId: string;
    positions: PositionSnapshot[];
    indexSets: bigint[];
}

export interface SettlementRedeemResult {
    status: 'confirmed' | 'retry' | 'failed';
    reason: string;
    transactionHashes: string[];
    confirmedAt?: number;
}
