import mongoose from 'mongoose';
import type { WorkflowExecutionRecord, WorkflowExecutionStatus, SourceTradeEvent } from '../..';
import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { countFixedAmountTrades, isAggregatedBuyBundle } from '../../../utils/copytradeDispatch';
import { computeRetryDelayMs } from '../../../utils/retry';
import { CopyTradeNode } from './CopyTradeNode';

interface EventPersistencePlan {
    event: SourceTradeEvent;
    status: WorkflowExecutionStatus;
    requestedUsdc: number;
    requestedSize: number;
    executedUsdc: number;
    executedSize: number;
    reason: string;
    delayMs?: number;
}

const emptyExecutionResult = {
    status: 'skipped' as const,
    reason: '节点链未生成执行结果',
    requestedUsdc: 0,
    requestedSize: 0,
    executedUsdc: 0,
    executedSize: 0,
    executionPrice: 0,
    orderIds: [],
    transactionHashes: [],
};

const clampCount = (value: number, max: number) => Math.max(Math.min(Math.trunc(value), max), 0);

const getSourceEvents = (ctx: NodeContext<CopyTradeWorkflowState>) => {
    const candidates =
        ctx.state.sourceEvents && ctx.state.sourceEvents.length > 0
            ? ctx.state.sourceEvents
            : ctx.state.sourceEvent
              ? [ctx.state.sourceEvent]
              : [];

    return candidates.filter((event): event is SourceTradeEvent => Boolean(event && event._id));
};

const buildExecutionRecord = (
    ctx: NodeContext<CopyTradeWorkflowState>,
    result: CopyTradeWorkflowState['executionResult'],
    plan: EventPersistencePlan
): WorkflowExecutionRecord => ({
    workflowId: ctx.workflowId,
    strategyKind: ctx.strategyKind!,
    runMode: ctx.runMode,
    sourceEventId: new mongoose.Types.ObjectId(String(plan.event._id)),
    sourceWallet: plan.event.sourceWallet,
    activityKey: plan.event.activityKey,
    conditionId: plan.event.conditionId,
    asset: plan.event.asset,
    side: plan.event.side,
    action: plan.event.action,
    status: plan.status,
    requestedUsdc: plan.requestedUsdc,
    requestedSize: plan.requestedSize,
    executedUsdc: plan.executedUsdc,
    executedSize: plan.executedSize,
    executionPrice: result?.executionPrice || 0,
    orderIds: result?.orderIds || [],
    transactionHashes: result?.transactionHashes || [],
    reason: plan.reason,
    note: ctx.state.sizingDecision?.note || '',
    policyTrail: ctx.state.policyTrail || [],
    matchedAt: result?.matchedAt,
    minedAt: result?.minedAt,
    confirmedAt: result?.confirmedAt,
});

const resolveRetryPlan = (
    event: SourceTradeEvent,
    reason: string,
    baseDelayMs: number,
    maxRetryCount: number,
    requestedUsdc = 0,
    requestedSize = 0
): EventPersistencePlan => {
    const nextAttempt = Math.max(Number(event.attemptCount) || 0, 0) + 1;
    if (nextAttempt > maxRetryCount) {
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
        delayMs: computeRetryDelayMs(baseDelayMs, nextAttempt),
    };
};

export class PersistExecutionNode extends CopyTradeNode {
    constructor() {
        super('copytrade.persist');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const result = ctx.state.executionResult || emptyExecutionResult;
        const sourceEvents = getSourceEvents(ctx);
        if (sourceEvents.length === 0) {
            return this.fail('缺少待落库的源事件', null);
        }

        const plans = this.buildPersistencePlans(ctx, sourceEvents, result);
        for (const plan of plans) {
            await ctx.runtime.stores.executions.save(buildExecutionRecord(ctx, result, plan));
        }

        const now = ctx.now();
        const confirmedConditions = new Set<string>();
        let hasConfirmed = false;
        let hasRetry = false;
        let hasFailed = false;

        for (const plan of plans) {
            const eventId = String(plan.event._id);
            if (plan.status === 'confirmed') {
                hasConfirmed = true;
                await ctx.runtime.stores.sourceEvents.markConfirmed(eventId, plan.reason, now);
                if (plan.event.conditionId && !confirmedConditions.has(plan.event.conditionId)) {
                    confirmedConditions.add(plan.event.conditionId);
                    await ctx.runtime.stores.settlementTasks.touchFromEvent(plan.event);
                }
                continue;
            }

            if (plan.status === 'skipped') {
                await ctx.runtime.stores.sourceEvents.markSkipped(eventId, plan.reason, now);
                continue;
            }

            if (plan.status === 'retry') {
                hasRetry = true;
                await ctx.runtime.stores.sourceEvents.markRetry(
                    eventId,
                    plan.reason,
                    now,
                    plan.delayMs || ctx.runtime.config.retryBackoffMs
                );
                continue;
            }

            hasFailed = true;
            await ctx.runtime.stores.sourceEvents.markFailed(eventId, plan.reason, now);
        }

        if (hasRetry && !hasConfirmed && !hasFailed) {
            const retryDelayMs = Math.min(
                ...plans
                    .filter((plan) => plan.status === 'retry')
                    .map((plan) => plan.delayMs || ctx.runtime.config.retryBackoffMs)
            );
            return this.retry(result.reason, retryDelayMs, null);
        }

        if (hasFailed && !hasConfirmed) {
            return this.fail(result.reason, null);
        }

        if (hasConfirmed) {
            return this.success(undefined, null, result.reason);
        }

        return this.skip(result.reason, null);
    }

    private buildPersistencePlans(
        ctx: NodeContext<CopyTradeWorkflowState>,
        sourceEvents: SourceTradeEvent[],
        result: NonNullable<CopyTradeWorkflowState['executionResult']>
    ) {
        const aggregateEvent = ctx.state.sourceEvent;
        if (
            sourceEvents.length > 1 &&
            aggregateEvent &&
            aggregateEvent.action === 'buy' &&
            ctx.runtime.config.strategyKind === 'fixed_amount' &&
            isAggregatedBuyBundle(aggregateEvent)
        ) {
            return this.buildFixedAmountBundlePlans(ctx, sourceEvents, result);
        }

        return [this.buildSingleEventPlan(ctx, sourceEvents[0]!, result)];
    }

    private buildSingleEventPlan(
        ctx: NodeContext<CopyTradeWorkflowState>,
        event: SourceTradeEvent,
        result: NonNullable<CopyTradeWorkflowState['executionResult']>
    ): EventPersistencePlan {
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
                ctx.runtime.config.retryBackoffMs,
                ctx.runtime.config.maxRetryCount,
                result.requestedUsdc,
                result.requestedSize
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
    }

    private buildFixedAmountBundlePlans(
        ctx: NodeContext<CopyTradeWorkflowState>,
        sourceEvents: SourceTradeEvent[],
        result: NonNullable<CopyTradeWorkflowState['executionResult']>
    ) {
        const perTradeUsdc = ctx.runtime.config.fixedTradeAmountUsdc;
        const perTradeSize = result.executionPrice > 0 ? perTradeUsdc / result.executionPrice : 0;
        const metadata = result.metadata || {};
        const plannedCount = clampCount(
            Number(metadata.bundlePlannedCount) ||
                countFixedAmountTrades(result.requestedUsdc, perTradeUsdc),
            sourceEvents.length
        );
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
                    ? executedCount < plannedCount
                        ? '聚合买单仅部分成交，剩余批次稍后重试'
                        : result.reason
                    : '聚合买单受余额或风控限制，剩余批次顺延到下一轮';
            plans.push(
                resolveRetryPlan(
                    event,
                    retryReason,
                    ctx.runtime.config.retryBackoffMs,
                    ctx.runtime.config.maxRetryCount,
                    index < plannedCount ? perTradeUsdc : 0,
                    index < plannedCount ? perTradeSize : 0
                )
            );
        }

        return plans;
    }
}
