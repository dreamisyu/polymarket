import type { StrategyKind, StrategyTicketTier } from '../value-objects/enums';

export interface StrategySizingDecision {
    status: 'ready' | 'skip';
    requestedUsdc?: number;
    requestedSize?: number;
    reason: string;
    note?: string;
    ticketTier?: StrategyTicketTier;
}

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    headNodeId: string;
}
