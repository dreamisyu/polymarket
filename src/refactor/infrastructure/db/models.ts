import mongoose, { Model, Schema } from 'mongoose';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementTask,
    SourceTradeEvent,
    WorkflowExecutionRecord,
} from '../../domain/types';

interface MonitorCursorState {
    wallet: string;
    lastSyncedTimestamp: number;
    lastSyncedActivityKey: string;
}

const normalizeKey = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

const getModel = <T>(modelName: string, schema: Schema, collectionName: string): Model<T> => {
    if (mongoose.models[modelName]) {
        return mongoose.models[modelName] as Model<T>;
    }

    return mongoose.model<T>(modelName, schema, collectionName);
};

const sourceEventSchema = new Schema<SourceTradeEvent>(
    {
        sourceWallet: { type: String, required: true },
        activityKey: { type: String, required: true },
        timestamp: { type: Number, required: true },
        type: { type: String, required: true },
        side: { type: String, required: true },
        action: { type: String, required: true },
        transactionHash: { type: String, required: true, default: '' },
        conditionId: { type: String, required: true, default: '' },
        asset: { type: String, required: true, default: '' },
        outcome: { type: String, required: false, default: '' },
        outcomeIndex: { type: Number, required: false, default: 0 },
        title: { type: String, required: false, default: '' },
        slug: { type: String, required: false, default: '' },
        eventSlug: { type: String, required: false, default: '' },
        price: { type: Number, required: false, default: 0 },
        size: { type: Number, required: false, default: 0 },
        usdcSize: { type: Number, required: false, default: 0 },
        executionIntent: { type: String, required: true, default: 'EXECUTE' },
        sourceBalanceAfterTrade: { type: Number, required: false },
        sourceBalanceBeforeTrade: { type: Number, required: false },
        sourcePositionSizeAfterTrade: { type: Number, required: false },
        sourcePositionSizeBeforeTrade: { type: Number, required: false },
        sourceConditionMergeableSizeAfterTrade: { type: Number, required: false },
        sourceConditionMergeableSizeBeforeTrade: { type: Number, required: false },
        sourceSnapshotCapturedAt: { type: Number, required: false },
        snapshotStatus: { type: String, required: false, default: '' },
        sourceSnapshotReason: { type: String, required: false, default: '' },
        status: { type: String, required: true, default: 'pending' },
        claimedAt: { type: Number, required: false, default: 0 },
        processedAt: { type: Number, required: false, default: 0 },
        nextRetryAt: { type: Number, required: false, default: 0 },
        attemptCount: { type: Number, required: false, default: 0 },
        lastError: { type: String, required: false, default: '' },
        raw: { type: Schema.Types.Mixed, required: false },
    },
    { timestamps: true }
);

sourceEventSchema.index({ activityKey: 1 }, { unique: true });
sourceEventSchema.index({ status: 1, nextRetryAt: 1, timestamp: 1 });

const executionSchema = new Schema<WorkflowExecutionRecord>(
    {
        workflowId: { type: String, required: true },
        strategyKind: { type: String, required: true },
        runMode: { type: String, required: true },
        sourceEventId: { type: Schema.Types.ObjectId, required: true },
        sourceWallet: { type: String, required: true },
        activityKey: { type: String, required: true },
        conditionId: { type: String, required: false, default: '' },
        asset: { type: String, required: false, default: '' },
        side: { type: String, required: false, default: '' },
        action: { type: String, required: true },
        status: { type: String, required: true },
        requestedUsdc: { type: Number, required: true, default: 0 },
        requestedSize: { type: Number, required: true, default: 0 },
        executedUsdc: { type: Number, required: true, default: 0 },
        executedSize: { type: Number, required: true, default: 0 },
        executionPrice: { type: Number, required: true, default: 0 },
        orderIds: { type: [String], required: true, default: [] },
        transactionHashes: { type: [String], required: true, default: [] },
        reason: { type: String, required: false, default: '' },
        note: { type: String, required: false, default: '' },
        policyTrail: { type: [String], required: false, default: [] },
        matchedAt: { type: Number, required: false, default: 0 },
        minedAt: { type: Number, required: false, default: 0 },
        confirmedAt: { type: Number, required: false, default: 0 },
    },
    { timestamps: true }
);

executionSchema.index({ sourceEventId: 1 }, { unique: true });

const positionSchema = new Schema<PositionSnapshot>(
    {
        asset: { type: String, required: true },
        conditionId: { type: String, required: true, default: '' },
        outcome: { type: String, required: false, default: '' },
        outcomeIndex: { type: Number, required: false, default: 0 },
        size: { type: Number, required: true, default: 0 },
        avgPrice: { type: Number, required: true, default: 0 },
        marketPrice: { type: Number, required: true, default: 0 },
        marketValue: { type: Number, required: true, default: 0 },
        costBasis: { type: Number, required: true, default: 0 },
        realizedPnl: { type: Number, required: true, default: 0 },
        redeemable: { type: Boolean, required: false, default: false },
        lastUpdatedAt: { type: Number, required: false, default: 0 },
    },
    { timestamps: true }
);

positionSchema.index({ asset: 1 }, { unique: true });

const portfolioSchema = new Schema<PortfolioSnapshot>(
    {
        cashBalance: { type: Number, required: true, default: 0 },
        realizedPnl: { type: Number, required: true, default: 0 },
        positionsMarketValue: { type: Number, required: true, default: 0 },
        totalEquity: { type: Number, required: true, default: 0 },
        activeExposureUsdc: { type: Number, required: true, default: 0 },
        openPositionCount: { type: Number, required: true, default: 0 },
        positions: {
            type: [
                {
                    asset: { type: String, required: true },
                    conditionId: { type: String, required: true, default: '' },
                    outcome: { type: String, required: false, default: '' },
                    outcomeIndex: { type: Number, required: false, default: 0 },
                    size: { type: Number, required: true, default: 0 },
                    avgPrice: { type: Number, required: true, default: 0 },
                    marketPrice: { type: Number, required: true, default: 0 },
                    marketValue: { type: Number, required: true, default: 0 },
                    costBasis: { type: Number, required: true, default: 0 },
                    realizedPnl: { type: Number, required: true, default: 0 },
                    redeemable: { type: Boolean, required: false, default: false },
                    lastUpdatedAt: { type: Number, required: false, default: 0 },
                },
            ],
            required: true,
            default: [],
        },
    },
    { timestamps: true }
);

const settlementTaskSchema = new Schema<SettlementTask>(
    {
        conditionId: { type: String, required: true },
        title: { type: String, required: false, default: '' },
        marketSlug: { type: String, required: false, default: '' },
        status: { type: String, required: true, default: 'pending' },
        reason: { type: String, required: false, default: '' },
        retryCount: { type: Number, required: true, default: 0 },
        lastCheckedAt: { type: Number, required: true, default: 0 },
        claimedAt: { type: Number, required: true, default: 0 },
        nextRetryAt: { type: Number, required: true, default: 0 },
        winnerOutcome: { type: String, required: false, default: '' },
    },
    { timestamps: true }
);

settlementTaskSchema.index({ conditionId: 1 }, { unique: true });
settlementTaskSchema.index({ status: 1, nextRetryAt: 1 });

const monitorCursorSchema = new Schema<MonitorCursorState>(
    {
        wallet: { type: String, required: true },
        lastSyncedTimestamp: { type: Number, required: true, default: 0 },
        lastSyncedActivityKey: { type: String, required: true, default: '' },
    },
    { timestamps: true }
);

monitorCursorSchema.index({ wallet: 1 }, { unique: true });

const buildCollectionName = (prefix: string, scopeKey: string) => `${prefix}_${normalizeKey(scopeKey)}`;

export const getSourceEventModel = (scopeKey: string) =>
    getModel<SourceTradeEvent>(
        `SourceEvents_${normalizeKey(scopeKey)}`,
        sourceEventSchema,
        buildCollectionName('source_events', scopeKey)
    );

export const getExecutionModel = (scopeKey: string) =>
    getModel<WorkflowExecutionRecord>(
        `Executions_${normalizeKey(scopeKey)}`,
        executionSchema,
        buildCollectionName('executions', scopeKey)
    );

export const getPositionModel = (scopeKey: string) =>
    getModel<PositionSnapshot>(
        `Positions_${normalizeKey(scopeKey)}`,
        positionSchema,
        buildCollectionName('positions', scopeKey)
    );

export const getPortfolioModel = (scopeKey: string) =>
    getModel<PortfolioSnapshot>(
        `Portfolios_${normalizeKey(scopeKey)}`,
        portfolioSchema,
        buildCollectionName('portfolios', scopeKey)
    );

export const getSettlementTaskModel = (scopeKey: string) =>
    getModel<SettlementTask>(
        `SettlementTasks_${normalizeKey(scopeKey)}`,
        settlementTaskSchema,
        buildCollectionName('settlement_tasks', scopeKey)
    );

export const getMonitorCursorModel = (scopeKey: string) =>
    getModel<MonitorCursorState>(
        `MonitorCursor_${normalizeKey(scopeKey)}`,
        monitorCursorSchema,
        buildCollectionName('monitor_cursors', scopeKey)
    );
