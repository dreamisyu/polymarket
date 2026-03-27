import mongoose from 'mongoose';
import type { SettlementTaskStatus } from '../value-objects/enums';

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
