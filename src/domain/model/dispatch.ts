import type { SourceTradeEvent } from './sourceTradeEvent';

export interface CopyTradeDispatchItem {
    dispatchId: string;
    sourceEvent: SourceTradeEvent;
    sourceEvents: SourceTradeEvent[];
    aggregated: boolean;
}
