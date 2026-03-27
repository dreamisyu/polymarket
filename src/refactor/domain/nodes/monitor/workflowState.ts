import type { MonitorSyncResult, SourceTradeEvent } from '../../domain';

export interface MonitorWorkflowState extends Record<string, unknown> {
    syncResult?: MonitorSyncResult;
    newEvents?: SourceTradeEvent[];
}
