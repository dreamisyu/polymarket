import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';

export class ClaimSourceEventNode extends CopyTradeNode {
    constructor() {
        super('copytrade.claim');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = await ctx.runtime.stores.sourceEvents.claimNextPending(ctx.now());
        ctx.state.sourceEvent = event;
        ctx.state.sizingDecision = undefined;
        ctx.state.executionResult = undefined;
        ctx.state.localPosition = undefined;
        ctx.state.portfolio = undefined;
        ctx.state.policyTrail = [];

        if (!event) {
            return this.skip('暂无待处理源事件', null);
        }

        return this.success({ activityKey: event.activityKey });
    }
}
