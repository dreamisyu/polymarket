import type { MonitorSyncResult, SourceTradeEvent } from '../../domain/types';

export interface MonitorWorkflowState extends Record<string, unknown> {
    syncResult?: MonitorSyncResult;
    newEvents?: SourceTradeEvent[];
}
