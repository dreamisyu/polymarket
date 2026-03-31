import type { CopyTradeDispatchItem, MonitorSyncResult, SourceTradeEvent } from '@domain';

export interface MonitorWorkflowState extends Record<string, unknown> {
    syncResult?: MonitorSyncResult;
    newEvents?: SourceTradeEvent[];
    dispatchItems?: CopyTradeDispatchItem[];
}
