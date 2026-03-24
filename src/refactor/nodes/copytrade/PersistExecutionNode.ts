import mongoose from 'mongoose';
import type { WorkflowExecutionRecord } from '../../domain/types';
import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';

export class PersistExecutionNode extends CopyTradeNode {
    constructor() {
        super('copytrade.persist');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const result =
            ctx.state.executionResult ||
            ({
                status: 'skipped',
                reason: '节点链未生成执行结果',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            } as const);

        if (!event || !event._id) {
            return this.fail('缺少待落库的源事件', null);
        }

        const executionRecord: WorkflowExecutionRecord = {
            workflowId: ctx.workflowId,
            strategyKind: ctx.strategyKind!,
            runMode: ctx.runMode,
            sourceEventId: new mongoose.Types.ObjectId(String(event._id)),
            sourceWallet: event.sourceWallet,
            activityKey: event.activityKey,
            conditionId: event.conditionId,
            asset: event.asset,
            side: event.side,
            action: event.action,
            status: result.status,
            requestedUsdc: result.requestedUsdc,
            requestedSize: result.requestedSize,
            executedUsdc: result.executedUsdc,
            executedSize: result.executedSize,
            executionPrice: result.executionPrice,
            orderIds: result.orderIds,
            transactionHashes: result.transactionHashes,
            reason: result.reason,
            note: ctx.state.sizingDecision?.note || '',
            policyTrail: ctx.state.policyTrail || [],
            matchedAt: result.matchedAt,
            minedAt: result.minedAt,
            confirmedAt: result.confirmedAt,
        };
        await ctx.runtime.stores.executions.save(executionRecord);

        const eventId = String(event._id);
        const now = ctx.now();
        if (result.status === 'confirmed') {
            await ctx.runtime.stores.sourceEvents.markConfirmed(eventId, result.reason, now);
            await ctx.runtime.stores.settlementTasks.touchFromEvent(event);
            return this.success(undefined, null, result.reason);
        }

        if (result.status === 'skipped') {
            await ctx.runtime.stores.sourceEvents.markSkipped(eventId, result.reason, now);
            return this.skip(result.reason, null);
        }

        if (result.status === 'retry') {
            await ctx.runtime.stores.sourceEvents.markRetry(
                eventId,
                result.reason,
                now,
                ctx.runtime.config.retryBackoffMs
            );
            return this.retry(result.reason, ctx.runtime.config.retryBackoffMs, null);
        }

        await ctx.runtime.stores.sourceEvents.markFailed(eventId, result.reason, now);
        return this.fail(result.reason, null);
    }
}
