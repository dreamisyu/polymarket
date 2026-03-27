import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';

export class ExecuteTradeNode extends CopyTradeNode {
    constructor() {
        super('copytrade.trade.execute');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const decision = ctx.state.sizingDecision;
        if (!event || !decision || decision.status !== 'ready') {
            return this.skip('缺少执行所需上下文', 'copytrade.persist');
        }

        const result = await ctx.runtime.gateways.trading.executeTrade({
            sourceEvent: event,
            requestedUsdc: decision.requestedUsdc,
            requestedSize: decision.requestedSize,
            note: decision.note,
        });
        ctx.state.executionResult = result;
        if (decision.ticketTier) {
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), `signal:${decision.ticketTier}`];
        }

        if (result.status === 'confirmed') {
            return this.success(result);
        }

        if (result.status === 'skipped') {
            return this.skip(result.reason, 'copytrade.persist');
        }

        if (result.status === 'retry') {
            return this.retry(result.reason, ctx.runtime.config.retryBackoffMs, 'copytrade.persist');
        }

        return this.fail(result.reason, 'copytrade.persist');
    }
}
