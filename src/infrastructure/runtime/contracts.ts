import type { Logger } from '../../utils/logger';
import type { RuntimeConfig } from '../../config/runtimeConfig';
import type {
    ConditionPositionSnapshot,
    MergeExecutionRequest,
    MonitorSyncResult,
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementRedeemRequest,
    SettlementRedeemResult,
    SettlementTask,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
    WorkflowExecutionRecord,
} from '../../domain';
import type { MarketBookSnapshot } from '../../utils/executionPlanning';
export type LoggerLike = Logger;

export interface SourceEventStore {
    upsertMany(events: SourceTradeEvent[]): Promise<SourceTradeEvent[]>;
    claimDueRetries(
        now: number,
        limit: number,
        options?: {
            processingLeaseMs?: number;
            maxRetryCount?: number;
        }
    ): Promise<SourceTradeEvent[]>;
    markProcessing(eventId: string, reason: string, now: number): Promise<void>;
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
    markSettled(
        taskId: string,
        winnerOutcome: string,
        reason: string,
        now: number,
        delayMs?: number
    ): Promise<void>;
    markClosed(taskId: string, winnerOutcome: string, reason: string, now: number): Promise<void>;
    markRetry(taskId: string, reason: string, now: number, delayMs: number): Promise<void>;
}

export interface MonitorGateway {
    syncOnce(): Promise<MonitorSyncResult>;
}

export interface TradingGateway {
    getPortfolioSnapshot(): Promise<PortfolioSnapshot>;
    getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null>;
    getMarketSnapshot(assetId: string): Promise<MarketBookSnapshot | null>;
    listConditionPositions(conditionId: string): Promise<ConditionPositionSnapshot>;
    executeTrade(request: TradeExecutionRequest): Promise<TradeExecutionResult>;
    executeMerge(request: MergeExecutionRequest): Promise<TradeExecutionResult>;
}

export interface SettlementGateway {
    executeRedeem(request: SettlementRedeemRequest): Promise<SettlementRedeemResult>;
}

export interface RuntimeStores {
    sourceEvents: SourceEventStore;
    executions: ExecutionStore;
    ledger?: LedgerStore;
    settlementTasks: SettlementTaskStore;
}

export interface RuntimeGateways {
    monitor: MonitorGateway;
    trading: TradingGateway;
    settlement: SettlementGateway;
}

export interface Runtime {
    config: RuntimeConfig;
    logger: LoggerLike;
    stores: RuntimeStores;
    gateways: RuntimeGateways;
}
