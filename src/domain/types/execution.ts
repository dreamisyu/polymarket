import mongoose from 'mongoose';
import { Side, type TickSize } from '@polymarket/clob-client';
import type {
    RunMode,
    StrategyKind,
    TradeAction,
    WorkflowExecutionStatus,
} from '@domain/value-objects/enums';
import type { SourceTradeEvent } from '@domain/types/sourceTradeEvent';

export interface BundlePersistenceItem {
    activityKey?: string;
    requestedUsdc: number;
    requestedSize: number;
    submittedUsdc?: number;
    submittedSize?: number;
    deferredReason?: string;
}

export interface TradeExecutionPersistenceContext {
    bundle?: {
        items: BundlePersistenceItem[];
    };
    [key: string]: unknown;
}

export interface TradeExecutionRequest {
    sourceEvent: SourceTradeEvent;
    sourceEvents?: SourceTradeEvent[];
    requestedUsdc: number;
    requestedSize: number;
    orderAmount: number;
    executionPrice: number;
    side: Side;
    tickSize: TickSize;
    negRisk?: boolean;
    note?: string;
    workflowId?: string;
    policyTrail?: string[];
    persistenceContext?: TradeExecutionPersistenceContext;
}

export interface MergeExecutionRequest {
    sourceEvent: SourceTradeEvent;
    requestedSize: number;
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
    persistenceContext?: TradeExecutionPersistenceContext;
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
