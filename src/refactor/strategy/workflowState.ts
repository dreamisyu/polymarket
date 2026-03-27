import type {
    ConditionPositionSnapshot,
    PortfolioSnapshot,
    PositionSnapshot,
    SourceTradeEvent,
    StrategySizingDecision,
    TradeExecutionResult,
} from '../domain/types';

export interface CopyTradeWorkflowState extends Record<string, unknown> {
    sourceEvent?: SourceTradeEvent | null;
    portfolio?: PortfolioSnapshot;
    localPosition?: PositionSnapshot | null;
    conditionPositions?: ConditionPositionSnapshot;
    sizingDecision?: StrategySizingDecision;
    executionResult?: TradeExecutionResult;
    policyTrail?: string[];
}
