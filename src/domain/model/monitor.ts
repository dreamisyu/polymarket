import type { SourceTradeEvent } from '@domain/model/sourceTradeEvent';

export interface MonitorSyncResult {
    events: SourceTradeEvent[];
    newEvents: SourceTradeEvent[];
    syncedAt: number;
}
