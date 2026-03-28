import type { StrategyKind, CopyTradeDispatchItem, SourceTradeEvent } from '../domain';
import { toSafeNumber } from './math';

const bundleRawKey = 'aggregatedBuyBundle';
const epsilon = 1e-8;

type EventRaw = Record<string, unknown>;

const getEventRaw = (event: SourceTradeEvent): EventRaw => {
    const raw = event.raw;
    return raw && typeof raw === 'object' ? (raw as EventRaw) : {};
};

const compareEvents = (left: SourceTradeEvent, right: SourceTradeEvent) =>
    left.timestamp === right.timestamp
        ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
        : left.timestamp - right.timestamp;

const dedupeEvents = (events: SourceTradeEvent[]) => {
    const byKey = new Map<string, SourceTradeEvent>();
    for (const event of events) {
        const activityKey = String(event.activityKey || '').trim();
        if (!activityKey) {
            continue;
        }

        byKey.set(activityKey, event);
    }

    return [...byKey.values()].sort(compareEvents);
};

const resolveSnapshotStatus = (events: SourceTradeEvent[]) => {
    if (events.some((event) => event.snapshotStatus === 'STALE')) {
        return 'STALE' as const;
    }
    if (events.some((event) => event.snapshotStatus === 'PARTIAL')) {
        return 'PARTIAL' as const;
    }
    if (events.every((event) => event.snapshotStatus === 'COMPLETE')) {
        return 'COMPLETE' as const;
    }

    return undefined;
};

const buildAggregateEvent = (events: SourceTradeEvent[]): SourceTradeEvent => {
    const ordered = [...events].sort(compareEvents);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const uniqueReasons = [
        ...new Set(
            ordered.map((event) => String(event.sourceSnapshotReason || '').trim()).filter(Boolean)
        ),
    ];
    const uniqueHashes = [
        ...new Set(
            ordered.map((event) => String(event.transactionHash || '').trim()).filter(Boolean)
        ),
    ];

    return {
        ...first,
        _id: undefined,
        activityKey: `bundle:${first.asset}:${first.price}:${first.timestamp}:${ordered.length}`,
        timestamp: first.timestamp,
        transactionHash: uniqueHashes[0] || '',
        size: ordered.reduce((sum, event) => sum + Math.max(toSafeNumber(event.size), 0), 0),
        usdcSize: ordered.reduce(
            (sum, event) => sum + Math.max(toSafeNumber(event.usdcSize), 0),
            0
        ),
        sourceBalanceBeforeTrade: first.sourceBalanceBeforeTrade,
        sourceBalanceAfterTrade: last.sourceBalanceAfterTrade,
        sourcePositionSizeBeforeTrade: first.sourcePositionSizeBeforeTrade,
        sourcePositionSizeAfterTrade: last.sourcePositionSizeAfterTrade,
        sourceConditionMergeableSizeBeforeTrade: first.sourceConditionMergeableSizeBeforeTrade,
        sourceConditionMergeableSizeAfterTrade: last.sourceConditionMergeableSizeAfterTrade,
        sourceSnapshotCapturedAt: Math.max(
            ...ordered.map((event) => toSafeNumber(event.sourceSnapshotCapturedAt, 0)),
            0
        ),
        snapshotStatus: resolveSnapshotStatus(ordered),
        sourceSnapshotReason: uniqueReasons.join('；'),
        raw: {
            ...getEventRaw(first),
            [bundleRawKey]: true,
            sourceActivityKeys: ordered.map((event) => event.activityKey),
            sourceTransactionHashes: uniqueHashes,
            sourceTradeCount: ordered.length,
            sourceStartedAt: first.timestamp,
            sourceEndedAt: last.timestamp,
        },
    };
};

const canAggregateFixedAmountBuy = (
    left: SourceTradeEvent,
    right: SourceTradeEvent,
    mergeWindowMs: number
) =>
    left.action === 'buy' &&
    right.action === 'buy' &&
    left.asset === right.asset &&
    Math.abs(toSafeNumber(left.price) - toSafeNumber(right.price)) <= epsilon &&
    right.timestamp - left.timestamp <= mergeWindowMs;

export const isAggregatedBuyBundle = (event: SourceTradeEvent) =>
    Boolean(getEventRaw(event)[bundleRawKey]);

export const getAggregatedTradeCount = (event: SourceTradeEvent) => {
    if (!isAggregatedBuyBundle(event)) {
        return 1;
    }

    return Math.max(Math.trunc(toSafeNumber(getEventRaw(event).sourceTradeCount, 1)), 1);
};

export const countFixedAmountTrades = (requestedUsdc: number, fixedTradeAmountUsdc: number) => {
    if (fixedTradeAmountUsdc <= 0) {
        return 0;
    }

    return Math.max(Math.floor((Math.max(requestedUsdc, 0) + epsilon) / fixedTradeAmountUsdc), 0);
};

export const trimFixedAmountUsdc = (requestedUsdc: number, fixedTradeAmountUsdc: number) =>
    countFixedAmountTrades(requestedUsdc, fixedTradeAmountUsdc) * Math.max(fixedTradeAmountUsdc, 0);

export const resolveFixedAmountBundleExecution = (params: {
    event: SourceTradeEvent;
    requestedUsdc: number;
    executableUsdc: number;
    fixedTradeAmountUsdc: number;
}) => {
    if (!isAggregatedBuyBundle(params.event) || params.event.action !== 'buy') {
        return null;
    }

    const plannedCount = Math.min(
        countFixedAmountTrades(params.requestedUsdc, params.fixedTradeAmountUsdc),
        getAggregatedTradeCount(params.event)
    );
    const executedCount = Math.min(
        countFixedAmountTrades(
            Math.min(params.executableUsdc, params.requestedUsdc),
            params.fixedTradeAmountUsdc
        ),
        plannedCount
    );

    return {
        plannedCount,
        executedCount,
        requestedUsdc: plannedCount * Math.max(params.fixedTradeAmountUsdc, 0),
        executableUsdc: executedCount * Math.max(params.fixedTradeAmountUsdc, 0),
    };
};

export const buildCopyTradeDispatchItems = (params: {
    events: SourceTradeEvent[];
    strategyKind: StrategyKind;
    mergeWindowMs: number;
}) => {
    const ordered = dedupeEvents(params.events).filter(
        (event) => event.executionIntent === 'EXECUTE'
    );
    if (ordered.length === 0) {
        return [] as CopyTradeDispatchItem[];
    }

    if (params.strategyKind !== 'fixed_amount') {
        return ordered.map((event) => ({
            dispatchId: event.activityKey,
            sourceEvent: event,
            sourceEvents: [event],
            aggregated: false,
        }));
    }

    const items: CopyTradeDispatchItem[] = [];
    let cursor: SourceTradeEvent[] = [];

    const flushCursor = () => {
        if (cursor.length === 0) {
            return;
        }

        if (cursor.length === 1) {
            const event = cursor[0]!;
            items.push({
                dispatchId: event.activityKey,
                sourceEvent: event,
                sourceEvents: [event],
                aggregated: false,
            });
            cursor = [];
            return;
        }

        const aggregateEvent = buildAggregateEvent(cursor);
        items.push({
            dispatchId: aggregateEvent.activityKey,
            sourceEvent: aggregateEvent,
            sourceEvents: [...cursor],
            aggregated: true,
        });
        cursor = [];
    };

    for (const event of ordered) {
        if (cursor.length === 0) {
            cursor = [event];
            continue;
        }

        const last = cursor[cursor.length - 1]!;
        if (canAggregateFixedAmountBuy(last, event, params.mergeWindowMs)) {
            cursor.push(event);
            continue;
        }

        flushCursor();
        cursor = [event];
    }

    flushCursor();
    return items;
};
