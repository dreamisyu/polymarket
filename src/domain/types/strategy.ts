import type { StrategyTicketTier } from '@domain/value-objects/enums';

export interface StrategySizingDecision {
    status: 'ready' | 'skip';
    requestedUsdc?: number;
    requestedSize?: number;
    reason: string;
    note?: string;
    ticketTier?: StrategyTicketTier;
}
