import type { SourceTradeEvent } from '@domain/model/sourceTradeEvent';

export interface CopyTradeDispatchItem {
    dispatchId: string;
    sourceEvent: SourceTradeEvent;
    sourceEvents: SourceTradeEvent[];
    aggregated: boolean;
}
