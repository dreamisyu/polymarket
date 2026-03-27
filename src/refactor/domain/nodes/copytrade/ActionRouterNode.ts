import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';

export class ActionRouterNode extends CopyTradeNode {
    private readonly strategyEntryNodeId: string;

    constructor(strategyEntryNodeId: string) {
        super('copytrade.action-router');
        this.strategyEntryNodeId = strategyEntryNodeId;
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
            return { next: this.strategyEntryNodeId };
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
