import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';

export class MergeExecuteNode extends CopyTradeNode {
    constructor() {
        super('copytrade.merge.execute');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const decision = ctx.state.sizingDecision;
        if (!event || !decision || decision.status !== 'ready' || !decision.requestedSize) {
            return this.skip('缺少 merge 执行上下文', 'copytrade.persist');
        }

        const result = await ctx.runtime.gateways.trading.executeMerge({
            sourceEvent: event,
            requestedSize: decision.requestedSize,
            note: decision.reason,
        });
        ctx.state.executionResult = result;
        if (result.status === 'confirmed') {
            return this.success(result, 'copytrade.persist');
        }
        if (result.status === 'skipped') {
            return this.skip(result.reason, 'copytrade.persist');
        }
        if (result.status === 'retry') {
            return this.retry(
                result.reason,
                ctx.runtime.config.retryBackoffMs,
                'copytrade.persist'
            );
        }

        return this.fail(result.reason, 'copytrade.persist');
    }
}
