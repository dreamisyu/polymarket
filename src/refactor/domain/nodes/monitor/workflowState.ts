import type { MonitorSyncResult, SourceTradeEvent } from '../..';

export interface MonitorWorkflowState extends Record<string, unknown> {
    syncResult?: MonitorSyncResult;
    newEvents?: SourceTradeEvent[];
}
