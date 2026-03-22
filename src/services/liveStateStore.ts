import mongoose from 'mongoose';
import {
    BuySizingMode,
    CopyExecutionBatchInterface,
    CopyExecutionBatchStatus,
    CopyIntentBufferInterface,
    ExecutionPolicyTrailEntry,
} from '../interfaces/Execution';
import {
    BotExecutionStatus,
    UserActivityInterface,
    UserPositionInterface,
} from '../interfaces/User';
import { hasPolicyId } from '../utils/executionPolicy';
import { mergeObjectIds, mergeStringArrays, toSafeNumber } from '../utils/runtime';

const EPSILON = 1e-8;
const BOOTSTRAP_POLICY_IDS = ['first-entry-ticket', 'buffer-min-top-up'];
const SIGNAL_TICKET_POLICY_IDS = [
    'signal-weak-ticket',
    'signal-fixed-ticket',
    'signal-strong-ticket',
];
const CONDITION_PAIR_POLICY_IDS = [
    'condition-leader-entry',
    'condition-strong-leader-entry',
    'condition-hedge-overlay',
];
const ACTIVE_BUY_BATCH_STATUSES = [
    'READY',
    'PROCESSING',
    'SUBMITTED',
    'PENDING_CONFIRMATION',
    'TIMEOUT',
];
const BLOCKING_CONFIRMATION_BATCH_STATUSES = ['SUBMITTED', 'PENDING_CONFIRMATION', 'TIMEOUT'];

export interface LiveTradeRuntimeState {
    trade: UserActivityInterface;
    status: BotExecutionStatus;
    retryCount: number;
    lastError: string;
    policyTrail: ExecutionPolicyTrailEntry[];
    bufferId?: mongoose.Types.ObjectId;
    batchId?: mongoose.Types.ObjectId;
    orderIds: string[];
    transactionHashes: string[];
    submittedAt?: number;
    confirmedAt?: number;
    matchedAt?: number;
    minedAt?: number;
    executedAt?: number;
}

const buildTradeKey = (
    trade: Pick<UserActivityInterface, 'activityKey' | 'transactionHash' | '_id'>
) => String(trade.activityKey || trade.transactionHash || trade._id);

const buildPositionKey = (subject: {
    asset?: string;
    conditionId?: string;
    outcomeIndex?: number;
    outcome?: string;
}) =>
    [
        String(subject.conditionId || '').trim(),
        String(subject.asset || '').trim(),
        Number.isFinite(subject.outcomeIndex)
            ? subject.outcomeIndex
            : String(subject.outcome || ''),
    ].join('|');

class LiveStateStore {
    private readonly tradeStates = new Map<string, LiveTradeRuntimeState>();
    private readonly pendingTradeKeys: string[] = [];
    private readonly buffersById = new Map<string, CopyIntentBufferInterface>();
    private readonly openBufferIdByKey = new Map<string, string>();
    private readonly batchesById = new Map<string, CopyExecutionBatchInterface>();
    private readonly queuedReadyBatchIds = new Set<string>();
    private readonly readyBatchIds: string[] = [];
    private readonly proxyPositions = new Map<string, UserPositionInterface>();
    private readonly bootstrapExposureByPositionKey = new Map<string, number>();

    ingestTrades(trades: UserActivityInterface[]) {
        let accepted = 0;
        for (const trade of trades) {
            const tradeKey = buildTradeKey(trade);
            const existing = this.tradeStates.get(tradeKey);
            if (existing) {
                existing.trade = trade;
                if (existing.status === 'PENDING' && !this.pendingTradeKeys.includes(tradeKey)) {
                    this.pendingTradeKeys.push(tradeKey);
                }
                continue;
            }

            this.tradeStates.set(tradeKey, {
                trade,
                status: 'PENDING',
                retryCount: 0,
                lastError: '',
                policyTrail: [],
                orderIds: [],
                transactionHashes: [],
            });
            this.pendingTradeKeys.push(tradeKey);
            accepted += 1;
        }

        return accepted;
    }

    listPendingTrades() {
        const pendingStates: LiveTradeRuntimeState[] = [];
        while (this.pendingTradeKeys.length > 0) {
            const tradeKey = this.pendingTradeKeys.shift();
            if (!tradeKey) {
                continue;
            }

            const state = this.tradeStates.get(tradeKey);
            if (!state || state.status !== 'PENDING') {
                continue;
            }

            pendingStates.push(state);
        }

        return pendingStates.sort((left, right) =>
            left.trade.timestamp === right.trade.timestamp
                ? buildTradeKey(left.trade).localeCompare(buildTradeKey(right.trade))
                : left.trade.timestamp - right.trade.timestamp
        );
    }

    getTradeState(trade: Pick<UserActivityInterface, 'activityKey' | 'transactionHash' | '_id'>) {
        return this.tradeStates.get(buildTradeKey(trade));
    }

    getTradesByIds(tradeIds: Array<mongoose.Types.ObjectId | string>) {
        const tradeIdSet = new Set(tradeIds.map((item) => String(item)));
        return [...this.tradeStates.values()]
            .filter((state) => tradeIdSet.has(String(state.trade._id)))
            .map((state) => state.trade)
            .sort((left, right) =>
                left.timestamp === right.timestamp
                    ? buildTradeKey(left).localeCompare(buildTradeKey(right))
                    : left.timestamp - right.timestamp
            );
    }

    markTradePending(
        trade: Pick<UserActivityInterface, 'activityKey' | 'transactionHash' | '_id'>,
        reason: string,
        incrementRetry = false
    ) {
        const state = this.getTradeState(trade);
        if (!state) {
            return;
        }

        state.status = 'PENDING';
        state.lastError = reason;
        if (incrementRetry) {
            state.retryCount += 1;
        }

        const tradeKey = buildTradeKey(trade);
        if (!this.pendingTradeKeys.includes(tradeKey)) {
            this.pendingTradeKeys.push(tradeKey);
        }
    }

    updateTradeState(
        trade: Pick<UserActivityInterface, 'activityKey' | 'transactionHash' | '_id'>,
        update: Partial<Omit<LiveTradeRuntimeState, 'trade'>>
    ) {
        const state = this.getTradeState(trade);
        if (!state) {
            return;
        }

        Object.assign(state, update);
    }

    createOrUpdateBuffer(buffer: CopyIntentBufferInterface) {
        const bufferId = String(buffer._id);
        this.buffersById.set(bufferId, buffer);
        if (buffer.state === 'OPEN') {
            this.openBufferIdByKey.set(buffer.bufferKey, bufferId);
        } else if (this.openBufferIdByKey.get(buffer.bufferKey) === bufferId) {
            this.openBufferIdByKey.delete(buffer.bufferKey);
        }

        for (const tradeId of buffer.sourceTradeIds) {
            const state = [...this.tradeStates.values()].find(
                (item) => String(item.trade._id) === String(tradeId)
            );
            if (!state) {
                continue;
            }

            state.status = buffer.state === 'OPEN' ? 'BUFFERED' : state.status;
            state.bufferId = buffer._id;
            state.lastError = buffer.reason || state.lastError;
            state.policyTrail = buffer.policyTrail || state.policyTrail;
        }
    }

    getOpenBuffer(bufferKey: string) {
        const bufferId = this.openBufferIdByKey.get(bufferKey);
        return bufferId ? this.buffersById.get(bufferId) || null : null;
    }

    closeBuffer(bufferId: mongoose.Types.ObjectId, state: 'CLOSED' | 'SKIPPED', reason: string) {
        const buffer = this.buffersById.get(String(bufferId));
        if (!buffer) {
            return;
        }

        buffer.state = state;
        buffer.reason = reason;
        buffer.claimedAt = 0;
        buffer.completedAt = Date.now();
        if (this.openBufferIdByKey.get(buffer.bufferKey) === String(bufferId)) {
            this.openBufferIdByKey.delete(buffer.bufferKey);
        }
    }

    listDueBuffers(now = Date.now()) {
        return [...this.buffersById.values()]
            .filter((buffer) => buffer.state === 'OPEN' && toSafeNumber(buffer.flushAfter) <= now)
            .sort((left, right) =>
                toSafeNumber(left.sourceStartedAt) === toSafeNumber(right.sourceStartedAt)
                    ? String(left._id).localeCompare(String(right._id))
                    : toSafeNumber(left.sourceStartedAt) - toSafeNumber(right.sourceStartedAt)
            );
    }

    listOpenBuffersForAsset(asset: string) {
        return [...this.buffersById.values()].filter(
            (buffer) =>
                buffer.state === 'OPEN' && buffer.condition === 'buy' && buffer.asset === asset
        );
    }

    createBatch(batch: CopyExecutionBatchInterface) {
        const batchId = String(batch._id);
        this.batchesById.set(batchId, batch);
        if (batch.status === 'READY' && !this.queuedReadyBatchIds.has(batchId)) {
            this.queuedReadyBatchIds.add(batchId);
            this.readyBatchIds.push(batchId);
        }

        for (const tradeId of batch.sourceTradeIds) {
            const state = [...this.tradeStates.values()].find(
                (item) => String(item.trade._id) === String(tradeId)
            );
            if (!state) {
                continue;
            }

            state.status =
                batch.status === 'PENDING_CONFIRMATION'
                    ? 'PENDING_CONFIRMATION'
                    : batch.status === 'SUBMITTED'
                      ? 'SUBMITTED'
                      : 'BATCHED';
            state.batchId = batch._id;
            state.bufferId = batch.bufferId;
            state.lastError = batch.reason || state.lastError;
            state.policyTrail = batch.policyTrail || state.policyTrail;
            state.orderIds = batch.orderIds || state.orderIds;
            state.transactionHashes = batch.transactionHashes || state.transactionHashes;
            state.submittedAt = batch.submittedAt;
            state.confirmedAt = batch.confirmedAt;
        }
    }

    getBatch(batchId: mongoose.Types.ObjectId | string) {
        return this.batchesById.get(String(batchId)) || null;
    }

    listReadyBatches() {
        const ready: CopyExecutionBatchInterface[] = [];
        while (this.readyBatchIds.length > 0) {
            const batchId = this.readyBatchIds.shift();
            if (!batchId) {
                continue;
            }

            this.queuedReadyBatchIds.delete(batchId);
            const batch = this.batchesById.get(batchId);
            if (!batch || batch.status !== 'READY') {
                continue;
            }

            ready.push(batch);
        }

        return ready.sort((left, right) =>
            toSafeNumber(left.sourceStartedAt) === toSafeNumber(right.sourceStartedAt)
                ? String(left._id).localeCompare(String(right._id))
                : toSafeNumber(left.sourceStartedAt) - toSafeNumber(right.sourceStartedAt)
        );
    }

    listSubmittedBatches() {
        return [...this.batchesById.values()].filter((batch) =>
            ['SUBMITTED', 'PENDING_CONFIRMATION', 'TIMEOUT'].includes(batch.status)
        );
    }

    markBatchProcessing(batchId: mongoose.Types.ObjectId) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return null;
        }

        batch.status = 'PROCESSING';
        batch.claimedAt = Date.now();
        return batch;
    }

    markBatchReady(batchId: mongoose.Types.ObjectId, reason: string, incrementRetry = false) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return;
        }

        batch.status = 'READY';
        batch.reason = reason;
        batch.claimedAt = 0;
        if (incrementRetry) {
            batch.retryCount = toSafeNumber(batch.retryCount) + 1;
        }

        if (!this.queuedReadyBatchIds.has(String(batchId))) {
            this.queuedReadyBatchIds.add(String(batchId));
            this.readyBatchIds.push(String(batchId));
        }
    }

    markBatchSubmitted(
        batchId: mongoose.Types.ObjectId,
        update: Partial<CopyExecutionBatchInterface>
    ) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return null;
        }

        Object.assign(batch, update, {
            status: 'SUBMITTED' as CopyExecutionBatchStatus,
            claimedAt: Date.now(),
            submittedAt: update.submittedAt || Date.now(),
        });
        return batch;
    }

    markBatchPendingConfirmation(
        batchId: mongoose.Types.ObjectId,
        reason: string,
        submissionStatus?: CopyExecutionBatchInterface['submissionStatus']
    ) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return null;
        }

        batch.status = 'PENDING_CONFIRMATION';
        batch.reason = reason;
        batch.claimedAt = 0;
        if (submissionStatus) {
            batch.submissionStatus = submissionStatus;
        }
        return batch;
    }

    markBatchTimeout(batchId: mongoose.Types.ObjectId, reason: string) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return null;
        }

        batch.status = 'TIMEOUT';
        batch.reason = reason;
        batch.claimedAt = 0;
        return batch;
    }

    markBatchTerminal(
        batchId: mongoose.Types.ObjectId,
        status: 'CONFIRMED' | 'SKIPPED' | 'FAILED',
        reason: string,
        confirmedAt?: number
    ) {
        const batch = this.getBatch(batchId);
        if (!batch) {
            return null;
        }

        batch.status = status;
        batch.reason = reason;
        batch.claimedAt = 0;
        batch.confirmedAt = confirmedAt || batch.confirmedAt || 0;
        batch.completedAt = Date.now();
        return batch;
    }

    listActiveBuyBatchesForAsset(asset: string) {
        return [...this.batchesById.values()].filter(
            (batch) =>
                batch.asset === asset &&
                batch.condition === 'buy' &&
                ACTIVE_BUY_BATCH_STATUSES.includes(batch.status)
        );
    }

    getActiveBuyBatch(trade: Pick<UserActivityInterface, 'asset' | 'conditionId'>) {
        return (
            [...this.batchesById.values()]
                .filter(
                    (batch) =>
                        batch.asset === trade.asset &&
                        batch.conditionId === trade.conditionId &&
                        batch.condition === 'buy' &&
                        ACTIVE_BUY_BATCH_STATUSES.includes(batch.status)
                )
                .sort(
                    (left, right) =>
                        toSafeNumber(right.sourceEndedAt) - toSafeNumber(left.sourceEndedAt)
                )[0] || null
        );
    }

    reservedBuyExposureUsdc() {
        return [
            ...[...this.buffersById.values()].filter(
                (buffer) => buffer.state === 'OPEN' && buffer.condition === 'buy'
            ),
            ...[...this.batchesById.values()].filter(
                (batch) =>
                    ACTIVE_BUY_BATCH_STATUSES.includes(batch.status) && batch.condition === 'buy'
            ),
        ].reduce((sum, item) => sum + Math.max(toSafeNumber(item.requestedUsdc), 0), 0);
    }

    findBlockingBatch(
        subject: Pick<UserActivityInterface, 'asset' | 'conditionId'>,
        excludeBatchId?: mongoose.Types.ObjectId | string
    ) {
        return (
            [...this.batchesById.values()].find(
                (batch) =>
                    batch.asset === subject.asset &&
                    batch.conditionId === subject.conditionId &&
                    BLOCKING_CONFIRMATION_BATCH_STATUSES.includes(batch.status) &&
                    String(batch._id) !== String(excludeBatchId || '')
            ) || null
        );
    }

    activeBootstrapExposureUsdc() {
        const openExposure = [
            ...[...this.buffersById.values()].filter(
                (buffer) =>
                    buffer.state === 'OPEN' &&
                    buffer.condition === 'buy' &&
                    hasPolicyId(buffer.policyTrail, BOOTSTRAP_POLICY_IDS)
            ),
            ...[...this.batchesById.values()].filter(
                (batch) =>
                    ACTIVE_BUY_BATCH_STATUSES.includes(batch.status) &&
                    batch.condition === 'buy' &&
                    hasPolicyId(batch.policyTrail, BOOTSTRAP_POLICY_IDS)
            ),
        ].reduce((sum, item) => sum + Math.max(toSafeNumber(item.requestedUsdc), 0), 0);

        return (
            openExposure +
            [...this.bootstrapExposureByPositionKey.values()].reduce(
                (sum, value) => sum + Math.max(toSafeNumber(value), 0),
                0
            )
        );
    }

    countSignalTickets(subject: Pick<UserActivityInterface, 'asset' | 'conditionId'>) {
        return [...this.batchesById.values()].filter(
            (batch) =>
                batch.asset === subject.asset &&
                batch.conditionId === subject.conditionId &&
                batch.condition === 'buy' &&
                !['SKIPPED', 'FAILED'].includes(batch.status) &&
                hasPolicyId(batch.policyTrail, SIGNAL_TICKET_POLICY_IDS)
        ).length;
    }

    getConditionPairActionOutcomes(conditionId: string) {
        const outcomes = new Set<string>();
        for (const batch of this.batchesById.values()) {
            if (
                batch.conditionId === conditionId &&
                batch.condition === 'buy' &&
                !['SKIPPED', 'FAILED'].includes(batch.status) &&
                hasPolicyId(batch.policyTrail, CONDITION_PAIR_POLICY_IDS)
            ) {
                outcomes.add(String(batch.outcome || '').trim());
            }
        }

        return [...outcomes].filter(Boolean);
    }

    countConditionPairActions(conditionId: string) {
        return this.getConditionPairActionOutcomes(conditionId).length;
    }

    markBootstrapExposure(
        subject: {
            asset?: string;
            conditionId?: string;
            outcomeIndex?: number;
            outcome?: string;
        },
        exposureUsdc: number
    ) {
        const positionKey = buildPositionKey(subject);
        if (!positionKey.trim()) {
            return;
        }

        if (exposureUsdc > 0) {
            this.bootstrapExposureByPositionKey.set(positionKey, exposureUsdc);
            return;
        }

        this.bootstrapExposureByPositionKey.delete(positionKey);
    }

    updateProxyPositions(positions: UserPositionInterface[]) {
        this.proxyPositions.clear();
        for (const position of positions) {
            this.proxyPositions.set(buildPositionKey(position), position);
        }

        for (const [positionKey] of this.bootstrapExposureByPositionKey) {
            const position = this.proxyPositions.get(positionKey);
            if (!position || Math.max(toSafeNumber(position.size), 0) <= EPSILON) {
                this.bootstrapExposureByPositionKey.delete(positionKey);
            }
        }
    }

    getProxyPositions() {
        return [...this.proxyPositions.values()];
    }

    markTradesByBatch(
        batch: CopyExecutionBatchInterface,
        update: Partial<Omit<LiveTradeRuntimeState, 'trade'>> & { status?: BotExecutionStatus }
    ) {
        const tradeIds = new Set(batch.sourceTradeIds.map((item) => String(item)));
        for (const state of this.tradeStates.values()) {
            if (!tradeIds.has(String(state.trade._id))) {
                continue;
            }

            Object.assign(state, update);
        }
    }

    mergeIntoOpenBuffer(
        existing: CopyIntentBufferInterface | null,
        params: {
            trade: UserActivityInterface;
            bufferKey: string;
            requestedUsdc: number;
            sourceUsdcTotal?: number;
            sourcePrice: number;
            flushAfter: number;
            reason: string;
            policyTrail: ExecutionPolicyTrailEntry[];
            bufferWindowMs?: number;
            sizingMode?: BuySizingMode;
        }
    ) {
        const {
            trade,
            bufferKey,
            requestedUsdc,
            sourceUsdcTotal = 0,
            sourcePrice,
            flushAfter,
            reason,
            policyTrail,
            bufferWindowMs = 0,
            sizingMode = 'ratio',
        } = params;

        if (!existing) {
            const buffer: CopyIntentBufferInterface = {
                _id: new mongoose.Types.ObjectId(),
                sourceWallet: trade.proxyWallet,
                bufferKey,
                state: 'OPEN',
                condition: 'buy',
                asset: trade.asset,
                conditionId: trade.conditionId,
                title: trade.title,
                outcome: trade.outcome,
                side: trade.side,
                sourceTradeIds: [trade._id],
                sourceActivityKeys: mergeStringArrays(trade.activityKey ? [trade.activityKey] : []),
                sourceTransactionHashes: mergeStringArrays([trade.transactionHash]),
                sourceTradeCount: 1,
                sourceStartedAt: trade.timestamp,
                sourceEndedAt: trade.timestamp,
                requestedUsdc,
                sourceUsdcTotal,
                sourcePrice,
                flushAfter,
                expireAt: flushAfter,
                bufferWindowMs,
                sizingMode,
                claimedAt: 0,
                reason,
                policyTrail,
                completedAt: 0,
            };
            this.createOrUpdateBuffer(buffer);
            return buffer;
        }

        existing.title = trade.title;
        existing.outcome = trade.outcome;
        existing.side = trade.side;
        existing.sourceTradeIds = mergeObjectIds(existing.sourceTradeIds, [trade._id]);
        existing.sourceActivityKeys = mergeStringArrays(
            existing.sourceActivityKeys,
            trade.activityKey ? [trade.activityKey] : []
        );
        existing.sourceTransactionHashes = mergeStringArrays(existing.sourceTransactionHashes, [
            trade.transactionHash,
        ]);
        existing.sourceTradeCount = Math.max(toSafeNumber(existing.sourceTradeCount), 0) + 1;
        existing.sourceStartedAt = Math.min(
            toSafeNumber(existing.sourceStartedAt, trade.timestamp),
            trade.timestamp
        );
        existing.sourceEndedAt = Math.max(toSafeNumber(existing.sourceEndedAt), trade.timestamp);
        existing.requestedUsdc = Math.max(toSafeNumber(existing.requestedUsdc), 0) + requestedUsdc;
        existing.sourceUsdcTotal =
            Math.max(toSafeNumber(existing.sourceUsdcTotal), 0) +
            Math.max(toSafeNumber(sourceUsdcTotal), 0);
        existing.sourcePrice = sourcePrice;
        existing.flushAfter = flushAfter;
        existing.expireAt = flushAfter;
        existing.bufferWindowMs = bufferWindowMs;
        existing.sizingMode = sizingMode;
        existing.reason = reason;
        existing.policyTrail = policyTrail;
        existing.completedAt = 0;
        this.createOrUpdateBuffer(existing);
        return existing;
    }
}

export { BOOTSTRAP_POLICY_IDS, buildPositionKey, buildTradeKey };
export default LiveStateStore;
