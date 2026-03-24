import type createLogger from '../../../utils/logger';
import type { RefactorConfig } from '../../config/runtimeConfig';
import type {
    PortfolioSnapshot,
    PositionSnapshot,
    SettlementTask,
    SourceTradeEvent,
    TradeExecutionRequest,
    TradeExecutionResult,
    WorkflowExecutionRecord,
} from '../../domain/types';

export type LoggerLike = ReturnType<typeof createLogger>;

export interface SourceEventStore {
    upsertMany(events: SourceTradeEvent[]): Promise<void>;
    claimNextPending(now: number): Promise<SourceTradeEvent | null>;
    markConfirmed(eventId: string, reason: string, now: number): Promise<void>;
    markSkipped(eventId: string, reason: string, now: number): Promise<void>;
    markRetry(eventId: string, reason: string, now: number, delayMs: number): Promise<void>;
    markFailed(eventId: string, reason: string, now: number): Promise<void>;
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
    touchFromEvent(event: SourceTradeEvent): Promise<void>;
    claimDue(now: number): Promise<SettlementTask | null>;
    markSettled(taskId: string, winnerOutcome: string, reason: string, now: number): Promise<void>;
    markRetry(taskId: string, reason: string, now: number, delayMs: number): Promise<void>;
}

export interface MonitorGateway {
    start(onEvents: (events: SourceTradeEvent[]) => Promise<void>): Promise<void>;
}

export interface TradingGateway {
    getPortfolioSnapshot(): Promise<PortfolioSnapshot>;
    getPositionForEvent(event: SourceTradeEvent): Promise<PositionSnapshot | null>;
    execute(request: TradeExecutionRequest): Promise<TradeExecutionResult>;
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
    config: RefactorConfig;
    logger: LoggerLike;
    stores: RefactorStores;
    gateways: RefactorGateways;
}
