import type {
    ConditionPositionSnapshot,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    StrategySizingDecision,
    TradeExecutionResult,
} from '..';

export interface CopyTradeWorkflowState extends Record<string, unknown> {
    sourceEvent?: SourceTradeEvent | null;
    sourceEvents?: SourceTradeEvent[];
    portfolio?: PortfolioSnapshot;
    localPosition?: PositionSnapshot | null;
    conditionPositions?: ConditionPositionSnapshot;
    sizingDecision?: StrategySizingDecision;
    executionResult?: TradeExecutionResult;
    policyTrail?: string[];
}
