import mongoose, { Model, Schema } from 'mongoose';
import {
    CopyExecutionBatchInterface,
    CopyIntentBufferInterface,
    ExecutionPolicyTrailEntry,
} from '../interfaces/Execution';

const normalizeKey = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();

const getModel = <T>(modelName: string, schema: Schema, collectionName: string): Model<T> => {
    if (mongoose.models[modelName]) {
        return mongoose.models[modelName] as Model<T>;
    }

    return mongoose.model<T>(modelName, schema, collectionName);
};

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

const copyIntentBufferSchema = new Schema<CopyIntentBufferInterface>(
    {
        sourceWallet: { type: String, required: true },
        bufferKey: { type: String, required: true },
        state: { type: String, required: true },
        condition: { type: String, required: true, default: '' },
        asset: { type: String, required: true, default: '' },
        conditionId: { type: String, required: false, default: '' },
        title: { type: String, required: false, default: '' },
        outcome: { type: String, required: false, default: '' },
        side: { type: String, required: false, default: '' },
        sourceTradeIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
        sourceActivityKeys: { type: [String], required: true, default: [] },
        sourceTransactionHashes: { type: [String], required: true, default: [] },
        sourceTradeCount: { type: Number, required: true, default: 0 },
        sourceStartedAt: { type: Number, required: true, default: 0 },
        sourceEndedAt: { type: Number, required: true, default: 0 },
        flushAfter: { type: Number, required: true, default: 0 },
        expireAt: { type: Number, required: true, default: 0 },
        claimedAt: { type: Number, required: false, default: 0 },
        reason: { type: String, required: false, default: '' },
        policyTrail: { type: [policyTrailEntrySchema], required: false, default: [] },
        completedAt: { type: Number, required: false, default: 0 },
    },
    { timestamps: true }
);

copyIntentBufferSchema.index({ bufferKey: 1, state: 1 });
copyIntentBufferSchema.index({ state: 1, flushAfter: 1, claimedAt: 1 });

const copyExecutionBatchSchema = new Schema<CopyExecutionBatchInterface>(
    {
        sourceWallet: { type: String, required: true },
        bufferId: { type: Schema.Types.ObjectId, required: false },
        status: { type: String, required: true },
        condition: { type: String, required: true, default: '' },
        asset: { type: String, required: true, default: '' },
        conditionId: { type: String, required: false, default: '' },
        title: { type: String, required: false, default: '' },
        outcome: { type: String, required: false, default: '' },
        side: { type: String, required: false, default: '' },
        sourceTradeIds: { type: [Schema.Types.ObjectId], required: true, default: [] },
        sourceActivityKeys: { type: [String], required: true, default: [] },
        sourceTransactionHashes: { type: [String], required: true, default: [] },
        sourceTradeCount: { type: Number, required: true, default: 0 },
        sourceStartedAt: { type: Number, required: true, default: 0 },
        sourceEndedAt: { type: Number, required: true, default: 0 },
        sourcePrice: { type: Number, required: true, default: 0 },
        requestedUsdc: { type: Number, required: true, default: 0 },
        requestedSize: { type: Number, required: true, default: 0 },
        orderIds: { type: [String], required: true, default: [] },
        transactionHashes: { type: [String], required: true, default: [] },
        policyTrail: { type: [policyTrailEntrySchema], required: false, default: [] },
        retryCount: { type: Number, required: true, default: 0 },
        claimedAt: { type: Number, required: false, default: 0 },
        submittedAt: { type: Number, required: false, default: 0 },
        confirmedAt: { type: Number, required: false, default: 0 },
        completedAt: { type: Number, required: false, default: 0 },
        reason: { type: String, required: false, default: '' },
        submissionStatus: { type: String, required: false, default: 'SUBMITTED' },
    },
    { timestamps: true }
);

copyExecutionBatchSchema.index({ status: 1, claimedAt: 1, submittedAt: 1 });
copyExecutionBatchSchema.index({ bufferId: 1 });

const buildSuffix = (walletAddress: string, namespace?: string) =>
    namespace
        ? `${normalizeKey(walletAddress)}_${normalizeKey(namespace)}`
        : normalizeKey(walletAddress);

const getCopyIntentBufferModel = (walletAddress: string, namespace?: string) => {
    const suffix = buildSuffix(walletAddress, namespace);
    const collectionName = `copy_intent_buffers_${suffix}`;
    const modelName = `CopyIntentBuffers_${suffix}`;
    return getModel<CopyIntentBufferInterface>(
        modelName,
        copyIntentBufferSchema,
        collectionName
    );
};

const getCopyExecutionBatchModel = (walletAddress: string, namespace?: string) => {
    const suffix = buildSuffix(walletAddress, namespace);
    const collectionName = `copy_execution_batches_${suffix}`;
    const modelName = `CopyExecutionBatches_${suffix}`;
    return getModel<CopyExecutionBatchInterface>(
        modelName,
        copyExecutionBatchSchema,
        collectionName
    );
};

export { getCopyExecutionBatchModel, getCopyIntentBufferModel };
