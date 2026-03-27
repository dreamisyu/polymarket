import type { Logger } from '../../utils/logger';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type {
    ConditionPositionSnapshot,
    MergeExecutionRequest,
    MonitorSyncResult,
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementTask,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
    WorkflowExecutionRecord,
} from '../../domain/types';
export type LoggerLike = Logger;

export interface SourceEventStore {
    upsertMany(events: SourceTradeEvent[]): Promise<SourceTradeEvent[]>;
    markConfirmed(eventId: string, reason: string, now: number): Promise<void>;
    markSkipped(eventId: string, reason: string, now: number): Promise<void>;
    markRetry(eventId: string, reason: string, now: number, delayMs: number): Promise<void>;
    markFailed(eventId: string, reason: string, now: number): Promise<void>;
    skipOutstandingByCondition(conditionId: string, reason: string, now: number): Promise<number>;
}

export interface ExecutionStore {
    save(record: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
}

export interface LedgerStore {
    ensurePortfolio(initialBalance: number): Promise<void>;
    getPortfolio(): Promise<PortfolioSnapshot>;
    listPositions(): Promise<PositionSnapshot[]>;
    findPositionByAsset(asset: string): Promise<PositionSnapshot | null>;
    savePosition(position: PositionSnapshot): Promise<void>;
    deletePosition(asset: string): Promise<void>;
    savePortfolio(snapshot: PortfolioSnapshot): Promise<void>;
}

export interface SettlementTaskStore {
    touchFromEvent(
        event: SourceTradeEvent,
        options?: { reason?: string; triggerNow?: boolean }
    ): Promise<void>;
    claimDue(now: number): Promise<SettlementTask | null>;
    markSettled(taskId: string, winnerOutcome: string, reason: string, now: number): Promise<void>;
    markRetry(taskId: string, reason: string, now: number, delayMs: number): Promise<void>;
}

export interface MonitorGateway {
    syncOnce(): Promise<MonitorSyncResult>;
}

export interface TradingGateway {
    getPortfolioSnapshot(): Promise<PortfolioSnapshot>;
    getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null>;
    listConditionPositions(conditionId: string): Promise<ConditionPositionSnapshot>;
    executeTrade(request: TradeExecutionRequest): Promise<TradeExecutionResult>;
    executeMerge(request: MergeExecutionRequest): Promise<TradeExecutionResult>;
}

export interface SettlementGateway {
    runDue(): Promise<void>;
}

export interface RefactorStores {
    sourceEvents: SourceEventStore;
    executions: ExecutionStore;
    ledger?: LedgerStore;
    settlementTasks: SettlementTaskStore;
}

export interface RefactorGateways {
    monitor: MonitorGateway;
    trading: TradingGateway;
    settlement: SettlementGateway;
}

export interface RefactorRuntime {
    config: RuntimeConfig;
    logger: LoggerLike;
    stores: RefactorStores;
    gateways: RefactorGateways;
}
