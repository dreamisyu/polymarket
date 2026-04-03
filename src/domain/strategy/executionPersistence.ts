import mongoose from 'mongoose';
import type {
    BundlePersistenceItem,
    RunMode,
    SourceTradeEvent,
    StrategyKind,
    TradeExecutionResult,
    WorkflowExecutionRecord,
    WorkflowExecutionStatus,
} from '@domain';
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

export interface BuildPersistencePlansParams {
    retryBackoffMs: number;
    maxRetryCount: number;
    sourceEvent?: SourceTradeEvent;
    sourceEvents: SourceTradeEvent[];
    result: TradeExecutionResult;
    retryDelayMsOverride?: number;
}

export interface ExecutionPersistencePlanner {
    buildPlans(params: BuildPersistencePlansParams): EventPersistencePlan[];
}

const partialBundleRetryReason = '聚合执行仅部分完成，剩余事件稍后重试';
const deferredBundleRetryReason = '聚合执行未覆盖当前事件，顺延到下一轮';

const clampNonNegative = (value: number) => Math.max(Number.isFinite(value) ? value : 0, 0);

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

const splitTotalByWeights = (total: number, weights: number[]) => {
    const normalizedTotal = clampNonNegative(total);
    const positiveWeights = weights.map((weight) => clampNonNegative(weight));
    const weightSum = positiveWeights.reduce((sum, weight) => sum + weight, 0);
    if (positiveWeights.length === 0) {
        return [] as number[];
    }
    if (normalizedTotal <= 0 || weightSum <= 0) {
        return positiveWeights.map(() => 0);
    }

    let remaining = normalizedTotal;
    return positiveWeights.map((weight, index) => {
        if (index === positiveWeights.length - 1) {
            return Math.max(remaining, 0);
        }

        const allocated = (normalizedTotal * weight) / weightSum;
        remaining = Math.max(remaining - allocated, 0);
        return allocated;
    });
};

const resolveBundleItems = (
    sourceEvents: SourceTradeEvent[],
    result: TradeExecutionResult
): BundlePersistenceItem[] => {
    const explicitItems = result.persistenceContext?.bundle?.items || [];
    if (explicitItems.length > 0) {
        const itemsByKey = new Map(
            explicitItems
                .filter((item) => String(item.activityKey || '').trim())
                .map((item) => [String(item.activityKey), item])
        );

        return sourceEvents.map((event, index) => {
            const explicitItem = itemsByKey.get(String(event.activityKey)) || explicitItems[index];
            if (explicitItem) {
                return {
                    activityKey: explicitItem.activityKey || event.activityKey,
                    requestedUsdc: clampNonNegative(explicitItem.requestedUsdc),
                    requestedSize: clampNonNegative(explicitItem.requestedSize),
                    submittedUsdc: clampNonNegative(explicitItem.submittedUsdc || 0),
                    submittedSize: clampNonNegative(explicitItem.submittedSize || 0),
                    deferredReason: explicitItem.deferredReason,
                };
            }

            return {
                activityKey: event.activityKey,
                requestedUsdc: 0,
                requestedSize: 0,
                submittedUsdc: 0,
                submittedSize: 0,
            };
        });
    }

    const requestedUsdcParts = splitTotalByWeights(
        result.requestedUsdc,
        sourceEvents.map((event) => clampNonNegative(Number(event.usdcSize) || 0))
    );
    const requestedSizeParts = splitTotalByWeights(
        result.requestedSize,
        sourceEvents.map((event) => clampNonNegative(Number(event.size) || 0))
    );
    const submittedUsdcParts = splitTotalByWeights(
        result.status === 'confirmed'
            ? result.executedUsdc
            : result.status === 'submitted'
              ? result.requestedUsdc
              : 0,
        sourceEvents.map((event) => clampNonNegative(Number(event.usdcSize) || 0))
    );
    const submittedSizeParts = splitTotalByWeights(
        result.status === 'confirmed'
            ? result.executedSize
            : result.status === 'submitted'
              ? result.requestedSize
              : 0,
        sourceEvents.map((event) => clampNonNegative(Number(event.size) || 0))
    );

    return sourceEvents.map((event, index) => ({
        activityKey: event.activityKey,
        requestedUsdc: requestedUsdcParts[index] || 0,
        requestedSize: requestedSizeParts[index] || 0,
        submittedUsdc: submittedUsdcParts[index] || 0,
        submittedSize: submittedSizeParts[index] || 0,
    }));
};

const buildBundlePlans = (
    sourceEvents: SourceTradeEvent[],
    result: TradeExecutionResult,
    options: {
        retryBackoffMs: number;
        maxRetryCount: number;
        retryDelayMsOverride?: number;
    }
) => {
    const bundleItems = resolveBundleItems(sourceEvents, result);

    return sourceEvents.map((event, index) => {
        const item = bundleItems[index] || {
            activityKey: event.activityKey,
            requestedUsdc: 0,
            requestedSize: 0,
            submittedUsdc: 0,
            submittedSize: 0,
        };
        const requestedUsdc = clampNonNegative(item.requestedUsdc);
        const requestedSize = clampNonNegative(item.requestedSize);
        const submittedUsdc = clampNonNegative(item.submittedUsdc || 0);
        const submittedSize = clampNonNegative(item.submittedSize || 0);

        if (result.status === 'confirmed' && (submittedUsdc > 0 || submittedSize > 0)) {
            return {
                event,
                status: 'confirmed' as const,
                requestedUsdc,
                requestedSize,
                executedUsdc: submittedUsdc,
                executedSize: submittedSize,
                reason: result.reason,
            };
        }

        if (result.status === 'submitted' && (submittedUsdc > 0 || submittedSize > 0)) {
            return {
                event,
                status: 'submitted' as const,
                requestedUsdc,
                requestedSize,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            };
        }

        if (result.status === 'skipped') {
            return {
                event,
                status: 'skipped' as const,
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            };
        }

        if (result.status === 'failed') {
            return {
                event,
                status: 'failed' as const,
                requestedUsdc,
                requestedSize,
                executedUsdc: 0,
                executedSize: 0,
                reason: result.reason,
            };
        }

        const retryReason =
            item.deferredReason ||
            (submittedUsdc > 0 || submittedSize > 0 ? partialBundleRetryReason : deferredBundleRetryReason) ||
            result.reason;
        return resolveRetryPlan(
            event,
            retryReason,
            options.retryBackoffMs,
            options.maxRetryCount,
            requestedUsdc,
            requestedSize,
            options.retryDelayMsOverride
        );
    });
};

export const defaultExecutionPersistencePlanner: ExecutionPersistencePlanner = {
    buildPlans(params) {
        if (params.sourceEvents.length <= 1) {
            return [
                buildSingleEventPlan(params.sourceEvents[0]!, params.result, {
                    retryBackoffMs: params.retryBackoffMs,
                    maxRetryCount: params.maxRetryCount,
                    retryDelayMsOverride: params.retryDelayMsOverride,
                }),
            ];
        }

        return buildBundlePlans(params.sourceEvents, params.result, {
            retryBackoffMs: params.retryBackoffMs,
            maxRetryCount: params.maxRetryCount,
            retryDelayMsOverride: params.retryDelayMsOverride,
        });
    },
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
