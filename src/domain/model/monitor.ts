import type { SourceTradeEvent } from './sourceTradeEvent';

export interface MonitorSyncResult {
    events: SourceTradeEvent[];
    newEvents: SourceTradeEvent[];
    syncedAt: number;
}
