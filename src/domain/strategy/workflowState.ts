import type {
    ConditionPositionSnapshot,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    StrategySizingDecision,
    TradeExecutionRequest,
    TradeExecutionResult,
} from '@domain';
import type { MarketBookSnapshot } from '@domain/trading/executionPlanning';

export interface CopyTradeWorkflowState extends Record<string, unknown> {
    sourceEvent?: SourceTradeEvent | null;
    sourceEvents?: SourceTradeEvent[];
    portfolio?: PortfolioSnapshot;
    localPosition?: PositionSnapshot | null;
    marketSnapshot?: MarketBookSnapshot | null;
    conditionPositions?: ConditionPositionSnapshot;
    sizingDecision?: StrategySizingDecision;
    tradeExecutionRequest?: TradeExecutionRequest;
    executionResult?: TradeExecutionResult;
    policyTrail?: string[];
}
