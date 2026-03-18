import mongoose, { Model, Schema } from 'mongoose';

const getModel = <T>(modelName: string, schema: Schema, collectionName: string): Model<T> => {
    if (mongoose.models[modelName]) {
        return mongoose.models[modelName] as Model<T>;
    }

    return mongoose.model<T>(modelName, schema, collectionName);
};

const positionSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    proxyWallet: { type: String, required: false },
    asset: { type: String, required: false },
    conditionId: { type: String, required: false },
    size: { type: Number, required: false },
    avgPrice: { type: Number, required: false },
    initialValue: { type: Number, required: false },
    currentValue: { type: Number, required: false },
    cashPnl: { type: Number, required: false },
    percentPnl: { type: Number, required: false },
    totalBought: { type: Number, required: false },
    realizedPnl: { type: Number, required: false },
    percentRealizedPnl: { type: Number, required: false },
    curPrice: { type: Number, required: false },
    redeemable: { type: Boolean, required: false },
    mergeable: { type: Boolean, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    oppositeOutcome: { type: String, required: false },
    oppositeAsset: { type: String, required: false },
    endDate: { type: String, required: false },
    negativeRisk: { type: Boolean, required: false },
});

const activitySchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    activityKey: { type: String, required: false },
    proxyWallet: { type: String, required: false },
    timestamp: { type: Number, required: false },
    conditionId: { type: String, required: false },
    type: { type: String, required: false },
    size: { type: Number, required: false },
    usdcSize: { type: Number, required: false },
    transactionHash: { type: String, required: false },
    price: { type: Number, required: false },
    asset: { type: String, required: false },
    side: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    name: { type: String, required: false },
    pseudonym: { type: String, required: false },
    bio: { type: String, required: false },
    profileImage: { type: String, required: false },
    profileImageOptimized: { type: String, required: false },
    bot: { type: Boolean, required: false },
    botExcutedTime: { type: Number, required: false },
    botStatus: { type: String, required: false },
    botClaimedAt: { type: Number, required: false },
    botExecutedAt: { type: Number, required: false },
    botLastError: { type: String, required: false },
    botOrderIds: { type: [String], required: false },
    botTransactionHashes: { type: [String], required: false },
    botSubmittedAt: { type: Number, required: false },
    botConfirmedAt: { type: Number, required: false },
    botMatchedAt: { type: Number, required: false },
    botMinedAt: { type: Number, required: false },
    botSubmissionStatus: { type: String, required: false },
    executionIntent: { type: String, required: false },
    sourceBalanceAfterTrade: { type: Number, required: false },
    sourceBalanceBeforeTrade: { type: Number, required: false },
    sourcePositionSizeAfterTrade: { type: Number, required: false },
    sourcePositionSizeBeforeTrade: { type: Number, required: false },
    sourcePositionPriceAfterTrade: { type: Number, required: false },
    sourceSnapshotCapturedAt: { type: Number, required: false },
    snapshotStatus: { type: String, required: false },
    sourceSnapshotReason: { type: String, required: false },
});

activitySchema.index({ activityKey: 1 }, { unique: true, sparse: true });
activitySchema.index({ transactionHash: 1 });
activitySchema.index({ type: 1, executionIntent: 1, botStatus: 1, timestamp: 1 });
activitySchema.index({ botClaimedAt: 1 });

const syncStateSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    walletAddress: { type: String, required: true },
    lastSyncedTimestamp: { type: Number, required: true, default: 0 },
    lastSyncedActivityKey: { type: String, required: false, default: '' },
    updatedAt: { type: Number, required: true, default: 0 },
});

const getUserPositionModel = (walletAddress: string) => {
    const collectionName = `user_positions_${walletAddress}`;
    return getModel(collectionName, positionSchema, collectionName);
};

const getUserActivityModel = (walletAddress: string) => {
    const collectionName = `user_activities_${walletAddress}`;
    return getModel(collectionName, activitySchema, collectionName);
};

const getUserActivitySyncStateModel = (walletAddress: string) => {
    const collectionName = `user_activity_sync_state_${walletAddress}`;
    return getModel(collectionName, syncStateSchema, collectionName);
};

export { getUserPositionModel, getUserActivityModel, getUserActivitySyncStateModel };
