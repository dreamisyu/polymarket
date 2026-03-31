import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';

const strategyEntryNodeIds = {
    fixed_amount: 'copytrade.fixed_amount.sizing',
    proportional: 'copytrade.proportional.sizing',
    signal: 'copytrade.signal.sizing',
} as const;

export class ActionRouterNode extends CopyTradeNode {
    constructor() {
        super('copytrade.action-router');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        if (!event) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '缺少待执行源事件',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip('缺少待执行源事件', 'copytrade.persist');
        }

        return this.success({ action: event.action });
    }

    async route(ctx: NodeContext<CopyTradeWorkflowState>, result: NodeResult) {
        if (result.status !== 'success') {
            return { stop: false };
        }

        const action = ctx.state.sourceEvent?.action;
        if (action === 'buy' || action === 'sell') {
            return { next: strategyEntryNodeIds[ctx.runtime.config.strategyKind] };
        }
        if (action === 'merge') {
            return { next: 'copytrade.merge.plan' };
        }
        if (action === 'redeem') {
            return { next: 'copytrade.redeem.forward' };
        }

        ctx.state.executionResult = {
            status: 'skipped',
            reason: `不支持的动作 ${String(action || 'unknown')}`,
            requestedUsdc: 0,
            requestedSize: 0,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: 0,
            orderIds: [],
            transactionHashes: [],
        };
        return { next: 'copytrade.persist' };
    }
}
