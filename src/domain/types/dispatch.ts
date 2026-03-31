import type { SourceTradeEvent } from '@domain/types/sourceTradeEvent';

export interface CopyTradeDispatchItem {
    dispatchId: string;
    sourceEvent: SourceTradeEvent;
    sourceEvents: SourceTradeEvent[];
    aggregated: boolean;
}
