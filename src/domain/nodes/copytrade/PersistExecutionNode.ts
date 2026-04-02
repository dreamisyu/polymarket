import mongoose from 'mongoose';
import type { SourceTradeEvent } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';
import { buildExecutionRecord, buildPersistencePlans } from '@application/workflow/ExecutionPersistence';

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

const getSourceEvents = (ctx: NodeContext<CopyTradeWorkflowState>) => {
    const candidates =
        ctx.state.sourceEvents && ctx.state.sourceEvents.length > 0
            ? ctx.state.sourceEvents
            : ctx.state.sourceEvent
              ? [ctx.state.sourceEvent]
              : [];

    return candidates.filter((event): event is SourceTradeEvent => Boolean(event && event._id));
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
            await ctx.runtime.stores.executions.save(
                buildExecutionRecord({
                    workflowId: ctx.workflowId,
                    strategyKind: ctx.strategyKind!,
                    runMode: ctx.runMode,
                    result,
                    plan,
                    note: ctx.state.sizingDecision?.note || '',
                    policyTrail: ctx.state.policyTrail || [],
                })
            );
        }

        const now = ctx.now();
        const confirmedConditions = new Set<string>();
        let hasConfirmed = false;
        let hasSubmitted = false;
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

            if (plan.status === 'submitted') {
                hasSubmitted = true;
                await ctx.runtime.stores.sourceEvents.markProcessing(eventId, plan.reason, now);
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

        if (hasSubmitted) {
            return this.success(undefined, null, result.reason);
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
        return buildPersistencePlans({
            strategyKind: ctx.runtime.config.strategyKind,
            fixedTradeAmountUsdc: ctx.runtime.config.fixedTradeAmountUsdc,
            retryBackoffMs: ctx.runtime.config.retryBackoffMs,
            maxRetryCount: ctx.runtime.config.maxRetryCount,
            sourceEvent: ctx.state.sourceEvent,
            sourceEvents,
            result,
        });
    }
}
