import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';

export class RedeemForwardNode extends CopyTradeNode {
    constructor() {
        super('copytrade.redeem.forward');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        if (!event) {
            return this.skip('缺少 REDEEM 源事件', 'copytrade.persist');
        }

        const reason = '源 REDEEM 已转交结算工作流';
        await ctx.runtime.stores.settlementTasks.touchFromEvent(event, {
            reason,
            triggerNow: true,
        });
        ctx.state.executionResult = {
            status: 'confirmed',
            reason,
            requestedUsdc: 0,
            requestedSize: 0,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: 0,
            orderIds: [],
            transactionHashes: [],
            confirmedAt: ctx.now(),
        };
        ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'redeem:settlement-forward'];
        return this.success(undefined, 'copytrade.persist', reason);
    }
}
