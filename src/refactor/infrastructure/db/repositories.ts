import mongoose from 'mongoose';
import type { RefactorConfig } from '../../config/runtimeConfig';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementTask,
    SourceTradeEvent,
    WorkflowExecutionRecord,
} from '../../domain/types';
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
            return;
        }

        await this.SourceEvent.bulkWrite(
            uniqueEvents.map((event) => {
                const normalizedStatus = event.executionIntent === 'SYNC_ONLY' ? 'skipped' : 'pending';
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
    }

    async claimNextPending(now: number) {
        const document = await this.SourceEvent.findOneAndUpdate(
            {
                executionIntent: 'EXECUTE',
                status: { $in: ['pending', 'retry'] },
                $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: 0 }, { nextRetryAt: { $lte: now } }],
            },
            {
                $set: {
                    status: 'processing',
                    claimedAt: now,
                    lastError: '',
                },
                $inc: {
                    attemptCount: 1,
                },
            },
            { sort: { timestamp: 1 }, new: true }
        ).lean<SourceTradeEvent | null>();

        return document || null;
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
}

class MongoExecutionStore implements ExecutionStore {
    private readonly Execution;

    constructor(scopeKey: string) {
        this.Execution = getExecutionModel(scopeKey);
    }

    async save(record: WorkflowExecutionRecord) {
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
        await this.Position.findOneAndUpdate({ asset: position.asset }, { $set: position }, { upsert: true });
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

    async touchFromEvent(event: SourceTradeEvent) {
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
                    reason: '',
                    nextRetryAt: 0,
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
                status: { $in: ['pending', 'processing'] },
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

    async markSettled(taskId: string, winnerOutcome: string, reason: string, now: number) {
        await this.SettlementTask.updateOne(
            { _id: new mongoose.Types.ObjectId(taskId) },
            {
                $set: {
                    status: 'settled',
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

export const createRefactorStores = (config: RefactorConfig) => ({
    sourceEvents: new MongoSourceEventStore(config.scopeKey),
    executions: new MongoExecutionStore(config.scopeKey),
    ledger: config.runMode === 'paper' ? new MongoLedgerStore(config.scopeKey) : undefined,
    settlementTasks: new MongoSettlementTaskStore(config.scopeKey),
});
