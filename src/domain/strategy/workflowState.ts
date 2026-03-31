import type {
    ConditionPositionSnapshot,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    TradeExecutionRequest,
    StrategySizingDecision,
    TradeExecutionResult,
} from '..';
import type { MarketBookSnapshot } from '@shared/executionPlanning';

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
