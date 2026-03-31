import mongoose from 'mongoose';
import type {
    RunMode,
    StrategyKind,
    TradeExecutionResult,
    WorkflowExecutionRecord,
    WorkflowExecutionStatus,
    SourceTradeEvent,
} from '../domain';
import { countFixedAmountTrades, isAggregatedBuyBundle } from '@shared/copytradeDispatch';
import { computeRetryDelayMs } from '@shared/retry';

export interface EventPersistencePlan {
    event: SourceTradeEvent;
    status: WorkflowExecutionStatus;
    requestedUsdc: number;
    requestedSize: number;
    executedUsdc: number;
    executedSize: number;
    reason: string;
    delayMs?: number;
}

const clampCount = (value: number, max: number) => Math.max(Math.min(Math.trunc(value), max), 0);

const resolveRetryPlan = (
    event: SourceTradeEvent,
    reason: string,
    baseDelayMs: number,
    maxRetryCount: number,
    requestedUsdc = 0,
    requestedSize = 0,
    delayMsOverride?: number
): EventPersistencePlan => {
    const nextAttempt = Math.max(Number(event.attemptCount) || 0, 0) + 1;
    if (maxRetryCount > 0 && nextAttempt > maxRetryCount) {
        return {
            event,
            status: 'failed',
            requestedUsdc,
            requestedSize,
            executedUsdc: 0,
            executedSize: 0,
            reason: `${reason}；已超过最大重试次数 ${maxRetryCount}`,
        };
    }

    return {
        event,
        status: 'retry',
        requestedUsdc,
        requestedSize,
        executedUsdc: 0,
        executedSize: 0,
        reason,
        delayMs:
            delayMsOverride !== undefined
                ? Math.max(Math.trunc(delayMsOverride), 0)
                : computeRetryDelayMs(baseDelayMs, nextAttempt),
    };
};

const buildSingleEventPlan = (
    event: SourceTradeEvent,
    result: TradeExecutionResult,
    options: {
        retryBackoffMs: number;
        maxRetryCount: number;
        retryDelayMsOverride?: number;
    }
): EventPersistencePlan => {
    if (result.status === 'confirmed') {
        return {
            event,
            status: 'confirmed',
            requestedUsdc: result.requestedUsdc,
            requestedSize: result.requestedSize,
            executedUsdc: result.executedUsdc,
            executedSize: result.executedSize,
            reason: result.reason,
        };
    }

    if (result.status === 'submitted') {
        return {
            event,
            status: 'submitted',
            requestedUsdc: result.requestedUsdc,
            requestedSize: result.requestedSize,
            executedUsdc: 0,
            executedSize: 0,
            reason: result.reason,
        };
    }

    if (result.status === 'skipped') {
        return {
            event,
            status: 'skipped',
            requestedUsdc: result.requestedUsdc,
            requestedSize: result.requestedSize,
            executedUsdc: 0,
            executedSize: 0,
            reason: result.reason,
        };
    }

    if (result.status === 'retry') {
        return resolveRetryPlan(
            event,
            result.reason,
            options.retryBackoffMs,
            options.maxRetryCount,
            result.requestedUsdc,
            result.requestedSize,
            options.retryDelayMsOverride
        );
    }

    return {
        event,
        status: 'failed',
        requestedUsdc: result.requestedUsdc,
        requestedSize: result.requestedSize,
        executedUsdc: 0,
        executedSize: 0,
        reason: result.reason,
    };
};

const buildFixedAmountBundlePlans = (
    sourceEvents: SourceTradeEvent[],
    result: TradeExecutionResult,
    options: {
        fixedTradeAmountUsdc: number;
        retryBackoffMs: number;
        maxRetryCount: number;
        retryDelayMsOverride?: number;
    }
) => {
    const perTradeUsdc = options.fixedTradeAmountUsdc;
    const perTradeSize = result.executionPrice > 0 ? perTradeUsdc / result.executionPrice : 0;
    const metadata = result.metadata || {};
    const plannedCount = clampCount(
        Number(metadata.bundlePlannedCount) ||
            countFixedAmountTrades(result.requestedUsdc, perTradeUsdc),
        sourceEvents.length
    );
    const submittedCount =
        result.status === 'submitted'
            ? clampCount(Number(metadata.bundleExecutedCount) || plannedCount, plannedCount)
            : 0;
    const executedCount =
        result.status === 'confirmed'
            ? clampCount(Number(metadata.bundleExecutedCount) || plannedCount, plannedCount)
            : 0;
    const plans: EventPersistencePlan[] = [];

    for (let index = 0; index < sourceEvents.length; index += 1) {
        const event = sourceEvents[index]!;
        if (result.status === 'confirmed' && index < executedCount) {
            plans.push({
                event,
                status: 'confirmed',
                requestedUsdc: perTradeUsdc,
                requestedSize: perTradeSize,
                executedUsdc: perTradeUsdc,
                executedSize: perTradeSize,
                reason: result.reason,
            });
            continue;
        }

        if (result.status === 'submitted' && index < submittedCount) {
            plans.push({
                event,
                status: 'submitted',
                requestedUsdc: perTradeUsdc,
                requestedSize: perTradeSize,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            });
            continue;
        }

        if (result.status === 'skipped') {
            plans.push({
                event,
                status: 'skipped',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            });
            continue;
        }

        if (result.status === 'failed') {
            plans.push({
                event,
                status: 'failed',
                requestedUsdc: index < plannedCount ? perTradeUsdc : 0,
                requestedSize: index < plannedCount ? perTradeSize : 0,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            });
            continue;
        }

        const retryReason =
            index < plannedCount
                ? Math.max(executedCount, submittedCount) < plannedCount
                    ? '聚合买单仅部分成交，剩余批次稍后重试'
                    : result.reason
                : '聚合买单受余额或风控限制，剩余批次顺延到下一轮';
        plans.push(
            resolveRetryPlan(
                event,
                retryReason,
                options.retryBackoffMs,
                options.maxRetryCount,
                index < plannedCount ? perTradeUsdc : 0,
                index < plannedCount ? perTradeSize : 0,
                options.retryDelayMsOverride
            )
        );
    }

    return plans;
};

export const buildPersistencePlans = (params: {
    strategyKind: StrategyKind;
    fixedTradeAmountUsdc: number;
    retryBackoffMs: number;
    maxRetryCount: number;
    sourceEvent?: SourceTradeEvent;
    sourceEvents: SourceTradeEvent[];
    result: TradeExecutionResult;
    retryDelayMsOverride?: number;
}) => {
    const aggregateEvent = params.sourceEvent;
    if (
        params.sourceEvents.length > 1 &&
        aggregateEvent &&
        aggregateEvent.action === 'buy' &&
        params.strategyKind === 'fixed_amount' &&
        isAggregatedBuyBundle(aggregateEvent)
    ) {
        return buildFixedAmountBundlePlans(params.sourceEvents, params.result, {
            fixedTradeAmountUsdc: params.fixedTradeAmountUsdc,
            retryBackoffMs: params.retryBackoffMs,
            maxRetryCount: params.maxRetryCount,
            retryDelayMsOverride: params.retryDelayMsOverride,
        });
    }

    return [
        buildSingleEventPlan(params.sourceEvents[0]!, params.result, {
            retryBackoffMs: params.retryBackoffMs,
            maxRetryCount: params.maxRetryCount,
            retryDelayMsOverride: params.retryDelayMsOverride,
        }),
    ];
};

export const buildExecutionRecord = (params: {
    workflowId: string;
    strategyKind: StrategyKind;
    runMode: RunMode;
    result: TradeExecutionResult;
    plan: EventPersistencePlan;
    note?: string;
    policyTrail?: string[];
}) =>
    ({
        workflowId: params.workflowId,
        strategyKind: params.strategyKind,
        runMode: params.runMode,
        sourceEventId: new mongoose.Types.ObjectId(String(params.plan.event._id)),
        sourceWallet: params.plan.event.sourceWallet,
        activityKey: params.plan.event.activityKey,
        conditionId: params.plan.event.conditionId,
        asset: params.plan.event.asset,
        side: params.plan.event.side,
        action: params.plan.event.action,
        status: params.plan.status,
        requestedUsdc: params.plan.requestedUsdc,
        requestedSize: params.plan.requestedSize,
        executedUsdc: params.plan.executedUsdc,
        executedSize: params.plan.executedSize,
        executionPrice: params.result.executionPrice || 0,
        orderIds: params.result.orderIds || [],
        transactionHashes: params.result.transactionHashes || [],
        reason: params.plan.reason,
        note: params.note || '',
        policyTrail: params.policyTrail || [],
        matchedAt: params.result.matchedAt,
        minedAt: params.result.minedAt,
        confirmedAt: params.result.confirmedAt,
    }) satisfies WorkflowExecutionRecord;
