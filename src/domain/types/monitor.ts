import type { SourceTradeEvent } from '@domain/types/sourceTradeEvent';

export interface MonitorSyncResult {
    events: SourceTradeEvent[];
    newEvents: SourceTradeEvent[];
    syncedAt: number;
}
