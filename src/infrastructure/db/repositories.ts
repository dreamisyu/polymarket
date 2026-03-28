import mongoose from 'mongoose';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementTask,
    SourceTradeEvent,
    WorkflowExecutionRecord,
} from '../../domain';
import type {
    ExecutionStore,
    LedgerStore,
    SettlementTaskStore,
    SourceEventStore,
} from '../runtime/contracts';
import {
    getExecutionModel,
    getPortfolioModel,
    getPositionModel,
    getSettlementTaskModel,
    getSourceEventModel,
} from './models';

const dedupeEvents = (events: SourceTradeEvent[]) => {
    const eventMap = new Map<string, SourceTradeEvent>();
    for (const event of events) {
        eventMap.set(event.activityKey, event);
    }

    return [...eventMap.values()];
};

class MongoSourceEventStore implements SourceEventStore {
    private readonly SourceEvent;

    constructor(scopeKey: string) {
        this.SourceEvent = getSourceEventModel(scopeKey);
    }

    async upsertMany(events: SourceTradeEvent[]) {
        const uniqueEvents = dedupeEvents(events).filter((event) => event.activityKey);
        if (uniqueEvents.length === 0) {
            return [];
        }

        const activityKeys = uniqueEvents.map((event) => event.activityKey);
        const existingEvents = await this.SourceEvent.find(
            { activityKey: { $in: activityKeys } },
            { activityKey: 1 }
        ).lean<Array<Pick<SourceTradeEvent, 'activityKey'>>>();
        const existingKeySet = new Set(
            existingEvents.map((event) => String(event.activityKey || '').trim()).filter(Boolean)
        );

        await this.SourceEvent.bulkWrite(
            uniqueEvents.map((event) => {
                const normalizedStatus =
                    event.executionIntent === 'SYNC_ONLY' ? 'skipped' : 'pending';
                return {
                    updateOne: {
                        filter: { activityKey: event.activityKey },
                        update: {
                            $set: {
                                ...event,
                                lastError: '',
                            },
                            $setOnInsert: {
                                status: normalizedStatus,
                                claimedAt: 0,
                                processedAt: 0,
                                nextRetryAt: 0,
                                attemptCount: 0,
                            },
                        },
                        upsert: true,
                    },
                };
            })
        );

        const newActivityKeys = uniqueEvents
            .filter((event) => !existingKeySet.has(event.activityKey))
            .map((event) => event.activityKey);
        if (newActivityKeys.length === 0) {
            return [];
        }

        const persistedEvents = await this.SourceEvent.find({
            activityKey: { $in: newActivityKeys },
        })
            .sort({ timestamp: 1 })
            .lean<SourceTradeEvent[]>();

        return persistedEvents || [];
    }

    async claimDueRetries(
        now: number,
        limit: number,
        options: {
            processingLeaseMs?: number;
            maxRetryCount?: number;
        } = {}
    ) {
        const claimedEvents: SourceTradeEvent[] = [];
        const maxItems = Math.max(Math.trunc(limit), 0);
        const processingLeaseMs = Math.max(Math.trunc(options.processingLeaseMs || 5 * 60_000), 1);
        const maxRetryCount = Math.max(Math.trunc(options.maxRetryCount || 0), 0);
        while (claimedEvents.length < maxItems) {
            const staleProcessingEvent = await this.claimStaleProcessing(
                now,
                processingLeaseMs,
                maxRetryCount
            );
            if (staleProcessingEvent === 'handled') {
                continue;
            }
            if (staleProcessingEvent) {
                claimedEvents.push(staleProcessingEvent);
                continue;
            }

            const nextEvent = await this.SourceEvent.findOneAndUpdate(
                {
                    executionIntent: 'EXECUTE',
                    status: 'retry',
                    $or: [{ nextRetryAt: 0 }, { nextRetryAt: { $lte: now } }],
                },
                {
                    $set: {
                        status: 'processing',
                        claimedAt: now,
                    },
                },
                { sort: { nextRetryAt: 1, timestamp: 1 }, new: true }
            ).lean<SourceTradeEvent | null>();

            if (!nextEvent) {
                break;
            }

            claimedEvents.push(nextEvent);
        }

        return claimedEvents;
    }

    private async claimStaleProcessing(
        now: number,
        processingLeaseMs: number,
        maxRetryCount: number
    ): Promise<SourceTradeEvent | 'handled' | null> {
        const staleProcessing = await this.SourceEvent.findOne(
            {
                executionIntent: 'EXECUTE',
                status: 'processing',
                claimedAt: { $gt: 0, $lte: now - processingLeaseMs },
            },
            {
                _id: 1,
                claimedAt: 1,
                attemptCount: 1,
                lastError: 1,
            }
        )
            .sort({ claimedAt: 1, timestamp: 1 })
            .lean<SourceTradeEvent | null>();
        if (!staleProcessing || !staleProcessing._id) {
            return null;
        }

        const nextAttempt = Math.max(Number(staleProcessing.attemptCount) || 0, 0) + 1;
        const baseReason = String(staleProcessing.lastError || '').trim() || '处理租约超时';
        if (maxRetryCount > 0 && nextAttempt > maxRetryCount) {
            await this.SourceEvent.updateOne(
                {
                    _id: new mongoose.Types.ObjectId(String(staleProcessing._id)),
                    status: 'processing',
                    claimedAt: staleProcessing.claimedAt,
                },
                {
                    $set: {
                        status: 'failed',
                        processedAt: now,
                        claimedAt: 0,
                        nextRetryAt: 0,
                        lastError: `${baseReason}；processing 租约超时，已超过最大重试次数 ${maxRetryCount}`,
                    },
                }
            );
            return 'handled';
        }

        const reclaimed = await this.SourceEvent.findOneAndUpdate(
            {
                _id: new mongoose.Types.ObjectId(String(staleProcessing._id)),
                status: 'processing',
                claimedAt: staleProcessing.claimedAt,
            },
            {
                $set: {
                    status: 'processing',
                    claimedAt: now,
                    nextRetryAt: 0,
                    lastError: `${baseReason}；processing 租约超时，已重新派发`,
                },
                $inc: {
                    attemptCount: 1,
                },
            },
            { new: true }
        ).lean<SourceTradeEvent | null>();

        return reclaimed || null;
    }

    async markConfirmed(eventId: string, reason: string, now: number) {
        await this.SourceEvent.updateOne(
            { _id: new mongoose.Types.ObjectId(eventId) },
            {
                $set: {
                    status: 'confirmed',
                    processedAt: now,
                    claimedAt: 0,
                    lastError: reason,
                },
            }
        );
    }

    async markProcessing(eventId: string, reason: string, now: number) {
        await this.SourceEvent.updateOne(
            {
                _id: new mongoose.Types.ObjectId(eventId),
                status: { $in: ['pending', 'retry', 'processing'] },
            },
            {
                $set: {
                    status: 'processing',
                    claimedAt: now,
                    nextRetryAt: 0,
                    lastError: reason,
                },
            }
        );
    }

    async markSkipped(eventId: string, reason: string, now: number) {
        await this.SourceEvent.updateOne(
            { _id: new mongoose.Types.ObjectId(eventId) },
            {
                $set: {
                    status: 'skipped',
                    processedAt: now,
                    claimedAt: 0,
                    lastError: reason,
                },
            }
        );
    }

    async markRetry(eventId: string, reason: string, now: number, delayMs: number) {
        await this.SourceEvent.updateOne(
            { _id: new mongoose.Types.ObjectId(eventId) },
            {
                $set: {
                    status: 'retry',
                    claimedAt: 0,
                    nextRetryAt: now + Math.max(delayMs, 0),
                    lastError: reason,
                },
                $inc: {
                    attemptCount: 1,
                },
            }
        );
    }

    async markFailed(eventId: string, reason: string, now: number) {
        await this.SourceEvent.updateOne(
            { _id: new mongoose.Types.ObjectId(eventId) },
            {
                $set: {
                    status: 'failed',
                    processedAt: now,
                    claimedAt: 0,
                    lastError: reason,
                },
            }
        );
    }

    async skipOutstandingByCondition(conditionId: string, reason: string, now: number) {
        const result = await this.SourceEvent.updateMany(
            {
                conditionId,
                executionIntent: 'EXECUTE',
                status: { $in: ['pending', 'retry'] },
            },
            {
                $set: {
                    status: 'skipped',
                    processedAt: now,
                    claimedAt: 0,
                    lastError: reason,
                },
            }
        );

        return result.modifiedCount;
    }
}

class MongoExecutionStore implements ExecutionStore {
    private readonly Execution;

    constructor(scopeKey: string) {
        this.Execution = getExecutionModel(scopeKey);
    }

    private shouldPreserveExisting(
        existingStatus: string,
        nextStatus: string
    ) {
        const normalizedExisting = String(existingStatus || '').trim().toLowerCase();
        const normalizedNext = String(nextStatus || '').trim().toLowerCase();
        if (!normalizedExisting) {
            return false;
        }
        if (normalizedExisting === 'confirmed') {
            return normalizedNext !== 'confirmed';
        }
        if (normalizedExisting === 'failed' || normalizedExisting === 'skipped') {
            return normalizedNext === 'submitted' || normalizedNext === 'retry';
        }

        return false;
    }

    async save(record: WorkflowExecutionRecord) {
        const existing = await this.Execution.findOne(
            { sourceEventId: record.sourceEventId },
            { status: 1 }
        ).lean<Pick<WorkflowExecutionRecord, 'status'> | null>();
        if (existing?.status && this.shouldPreserveExisting(existing.status, record.status)) {
            return (await this.Execution.findOne({
                sourceEventId: record.sourceEventId,
            }).lean<WorkflowExecutionRecord>()) as WorkflowExecutionRecord;
        }

        const response = await this.Execution.findOneAndUpdate(
            { sourceEventId: record.sourceEventId },
            { $set: record },
            { upsert: true, new: true }
        ).lean<WorkflowExecutionRecord>();

        return response as WorkflowExecutionRecord;
    }
}

class MongoLedgerStore implements LedgerStore {
    private readonly Portfolio;
    private readonly Position;

    constructor(scopeKey: string) {
        this.Portfolio = getPortfolioModel(scopeKey);
        this.Position = getPositionModel(scopeKey);
    }

    async ensurePortfolio(initialBalance: number) {
        const existing = await this.Portfolio.findOne().lean();
        if (existing) {
            return;
        }

        await this.Portfolio.create({
            cashBalance: initialBalance,
            realizedPnl: 0,
            positionsMarketValue: 0,
            totalEquity: initialBalance,
            activeExposureUsdc: 0,
            openPositionCount: 0,
            positions: [],
        });
    }

    async getPortfolio() {
        const portfolio = await this.Portfolio.findOne().lean<PortfolioSnapshot | null>();
        return (
            portfolio || {
                cashBalance: 0,
                realizedPnl: 0,
                positionsMarketValue: 0,
                totalEquity: 0,
                activeExposureUsdc: 0,
                openPositionCount: 0,
                positions: [],
            }
        );
    }

    async listPositions() {
        const positions = await this.Position.find().lean<PositionSnapshot[]>();
        return positions || [];
    }

    async findPositionByAsset(asset: string) {
        const position = await this.Position.findOne({ asset }).lean<PositionSnapshot | null>();
        return position || null;
    }

    async savePosition(position: PositionSnapshot) {
        await this.Position.findOneAndUpdate(
            { asset: position.asset },
            { $set: position },
            { upsert: true }
        );
    }

    async deletePosition(asset: string) {
        await this.Position.deleteOne({ asset });
    }

    async savePortfolio(snapshot: PortfolioSnapshot) {
        await this.Portfolio.findOneAndUpdate({}, { $set: snapshot }, { upsert: true });
    }
}

class MongoSettlementTaskStore implements SettlementTaskStore {
    private readonly SettlementTask;

    constructor(scopeKey: string) {
        this.SettlementTask = getSettlementTaskModel(scopeKey);
    }

    async touchFromEvent(
        event: SourceTradeEvent,
        options: { reason?: string; triggerNow?: boolean } = {}
    ) {
        if (!event.conditionId) {
            return;
        }

        await this.SettlementTask.findOneAndUpdate(
            { conditionId: event.conditionId },
            {
                $set: {
                    title: event.title,
                    marketSlug: event.slug || event.eventSlug,
                    status: 'pending',
                    reason: options.reason || '',
                    nextRetryAt: options.triggerNow ? 0 : 0,
                },
                $setOnInsert: {
                    retryCount: 0,
                    lastCheckedAt: 0,
                    claimedAt: 0,
                },
            },
            { upsert: true }
        );
    }

    async claimDue(now: number) {
        const task = await this.SettlementTask.findOneAndUpdate(
            {
                status: { $in: ['pending', 'processing', 'settled'] },
                $or: [{ nextRetryAt: 0 }, { nextRetryAt: { $lte: now } }],
            },
            {
                $set: {
                    status: 'processing',
                    claimedAt: now,
                    lastCheckedAt: now,
                },
            },
            { sort: { updatedAt: 1 }, new: true }
        ).lean<SettlementTask | null>();

        return task || null;
    }

    async markSettled(
        taskId: string,
        winnerOutcome: string,
        reason: string,
        now: number,
        delayMs = 0
    ) {
        await this.SettlementTask.updateOne(
            { _id: new mongoose.Types.ObjectId(taskId) },
            {
                $set: {
                    status: 'settled',
                    winnerOutcome,
                    reason,
                    claimedAt: 0,
                    nextRetryAt: now + Math.max(delayMs, 0),
                    lastCheckedAt: now,
                },
            }
        );
    }

    async markClosed(taskId: string, winnerOutcome: string, reason: string, now: number) {
        await this.SettlementTask.updateOne(
            { _id: new mongoose.Types.ObjectId(taskId) },
            {
                $set: {
                    status: 'closed',
                    winnerOutcome,
                    reason,
                    claimedAt: 0,
                    nextRetryAt: 0,
                    lastCheckedAt: now,
                },
            }
        );
    }

    async markRetry(taskId: string, reason: string, now: number, delayMs: number) {
        await this.SettlementTask.updateOne(
            { _id: new mongoose.Types.ObjectId(taskId) },
            {
                $set: {
                    status: 'pending',
                    reason,
                    claimedAt: 0,
                    nextRetryAt: now + Math.max(delayMs, 0),
                    lastCheckedAt: now,
                },
                $inc: {
                    retryCount: 1,
                },
            }
        );
    }
}

export const createStores = (config: RuntimeConfig) => ({
    sourceEvents: new MongoSourceEventStore(config.scopeKey),
    executions: new MongoExecutionStore(config.scopeKey),
    ledger: config.runMode === 'paper' ? new MongoLedgerStore(config.scopeKey) : undefined,
    settlementTasks: new MongoSettlementTaskStore(config.scopeKey),
});
