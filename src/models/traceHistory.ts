import mongoose, { Model, Schema } from 'mongoose';
import {
    TraceExecutionInterface,
    TracePortfolioInterface,
    TracePositionInterface,
} from '../interfaces/Trace';
import { ExecutionPolicyTrailEntry } from '../interfaces/Execution';

const normalizeKey = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

const getModel = <T>(modelName: string, schema: Schema, collectionName: string): Model<T> => {
    if (mongoose.models[modelName]) {
        return mongoose.models[modelName] as Model<T>;
    }

    return mongoose.model<T>(modelName, schema, collectionName);
};

const positionSchema = new Schema<TracePositionInterface>(
    {
        traceId: { type: String, required: true },
        traceLabel: { type: String, required: true },
        sourceWallet: { type: String, required: true },
        asset: { type: String, required: true },
        conditionId: { type: String, required: false },
        title: { type: String, required: false },
        outcome: { type: String, required: false },
        side: { type: String, required: false },
        size: { type: Number, required: true, default: 0 },
        avgPrice: { type: Number, required: true, default: 0 },
        costBasis: { type: Number, required: true, default: 0 },
        marketPrice: { type: Number, required: true, default: 0 },
        marketValue: { type: Number, required: true, default: 0 },
        realizedPnl: { type: Number, required: true, default: 0 },
        unrealizedPnl: { type: Number, required: true, default: 0 },
        totalBoughtSize: { type: Number, required: true, default: 0 },
        totalSoldSize: { type: Number, required: true, default: 0 },
        totalBoughtUsdc: { type: Number, required: true, default: 0 },
        totalSoldUsdc: { type: Number, required: true, default: 0 },
        lastSourceTransactionHash: { type: String, required: false },
        lastTradedAt: { type: Number, required: false },
        closedAt: { type: Number, required: false },
    },
    { timestamps: true }
);

positionSchema.index({ asset: 1 }, { unique: true });

const policyTrailEntrySchema = new Schema<ExecutionPolicyTrailEntry>(
    {
        policyId: { type: String, required: true },
        action: { type: String, required: true },
        reason: { type: String, required: true, default: '' },
        timestamp: { type: Number, required: true, default: 0 },
    },
    {
        _id: false,
    }
);

const executionSchema = new Schema<TraceExecutionInterface>(
    {
        traceId: { type: String, required: true },
        traceLabel: { type: String, required: true },
        sourceWallet: { type: String, required: true },
        sourceActivityId: { type: Schema.Types.ObjectId, required: false },
        sourceActivityIds: { type: [Schema.Types.ObjectId], required: false, default: [] },
        sourceActivityKey: { type: String, required: false },
        sourceActivityKeys: { type: [String], required: false, default: [] },
        sourceTransactionHash: { type: String, required: true },
        sourceTransactionHashes: { type: [String], required: false, default: [] },
        sourceTradeCount: { type: Number, required: false, default: 1 },
        sourceTimestamp: { type: Number, required: true, default: 0 },
        sourceStartedAt: { type: Number, required: false, default: 0 },
        sourceEndedAt: { type: Number, required: false, default: 0 },
        sourceSide: { type: String, required: false, default: '' },
        executionCondition: { type: String, required: false, default: '' },
        status: {
            type: String,
            enum: ['PROCESSING', 'FILLED', 'SKIPPED', 'FAILED'],
            required: true,
        },
        reason: { type: String, required: false, default: '' },
        asset: { type: String, required: false, default: '' },
        conditionId: { type: String, required: false },
        title: { type: String, required: false },
        outcome: { type: String, required: false },
        requestedSize: { type: Number, required: true, default: 0 },
        executedSize: { type: Number, required: true, default: 0 },
        requestedUsdc: { type: Number, required: true, default: 0 },
        executedUsdc: { type: Number, required: true, default: 0 },
        executionPrice: { type: Number, required: true, default: 0 },
        cashBefore: { type: Number, required: true, default: 0 },
        cashAfter: { type: Number, required: true, default: 0 },
        positionSizeBefore: { type: Number, required: true, default: 0 },
        positionSizeAfter: { type: Number, required: true, default: 0 },
        realizedPnlDelta: { type: Number, required: true, default: 0 },
        realizedPnlTotal: { type: Number, required: true, default: 0 },
        unrealizedPnlAfter: { type: Number, required: true, default: 0 },
        totalEquityAfter: { type: Number, required: true, default: 0 },
        copyIntentBufferId: { type: Schema.Types.ObjectId, required: false },
        copyExecutionBatchId: { type: Schema.Types.ObjectId, required: false },
        policyTrail: { type: [policyTrailEntrySchema], required: false, default: [] },
        claimedAt: { type: Number, required: false, default: 0 },
        completedAt: { type: Number, required: false, default: 0 },
    },
    { timestamps: true }
);

executionSchema.index({ sourceActivityKey: 1 }, { unique: true, sparse: true });
executionSchema.index({ sourceTransactionHash: 1 });

const portfolioSchema = new Schema<TracePortfolioInterface>(
    {
        traceId: { type: String, required: true },
        traceLabel: { type: String, required: true },
        sourceWallet: { type: String, required: true },
        initialBalance: { type: Number, required: true },
        cashBalance: { type: Number, required: true },
        realizedPnl: { type: Number, required: true, default: 0 },
        unrealizedPnl: { type: Number, required: true, default: 0 },
        positionsMarketValue: { type: Number, required: true, default: 0 },
        totalEquity: { type: Number, required: true },
        netPnl: { type: Number, required: true, default: 0 },
        returnPct: { type: Number, required: true, default: 0 },
        totalExecutions: { type: Number, required: true, default: 0 },
        filledExecutions: { type: Number, required: true, default: 0 },
        skippedExecutions: { type: Number, required: true, default: 0 },
        lastSourceTransactionHash: { type: String, required: false, default: '' },
        lastUpdatedAt: { type: Number, required: false, default: 0 },
    },
    { timestamps: true }
);

const getTracePositionModel = (walletAddress: string, traceId: string) => {
    const suffix = `${normalizeKey(walletAddress)}_${normalizeKey(traceId)}`;
    const collectionName = `trace_positions_${suffix}`;
    const modelName = `TracePositions_${suffix}`;
    return getModel<TracePositionInterface>(modelName, positionSchema, collectionName);
};

const getTraceExecutionModel = (walletAddress: string, traceId: string) => {
    const suffix = `${normalizeKey(walletAddress)}_${normalizeKey(traceId)}`;
    const collectionName = `trace_executions_${suffix}`;
    const modelName = `TraceExecutions_${suffix}`;
    return getModel<TraceExecutionInterface>(modelName, executionSchema, collectionName);
};

const getTracePortfolioModel = (walletAddress: string, traceId: string) => {
    const suffix = `${normalizeKey(walletAddress)}_${normalizeKey(traceId)}`;
    const collectionName = `trace_portfolios_${suffix}`;
    const modelName = `TracePortfolios_${suffix}`;
    return getModel<TracePortfolioInterface>(modelName, portfolioSchema, collectionName);
};

export { getTraceExecutionModel, getTracePortfolioModel, getTracePositionModel };
