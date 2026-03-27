import type { StrategySizingDecision } from '../../domain/types';
import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { computeFixedAmountDecision, computeProportionalDecision, computeSignalDecision } from '../../utils/strategySizing';
import { CopyTradeNode } from './CopyTradeNode';

abstract class BaseSizingNode extends CopyTradeNode {
    protected abstract evaluate(ctx: NodeContext<CopyTradeWorkflowState>): StrategySizingDecision;

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        if (!event) {
            return this.skip('缺少待执行源事件', 'copytrade.persist');
        }

        const decision = this.evaluate(ctx);
        ctx.state.sizingDecision = decision;
        if (decision.status === 'skip') {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: decision.reason,
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(decision.reason, 'copytrade.persist');
        }

        return this.success({
            requestedUsdc: decision.requestedUsdc || 0,
            requestedSize: decision.requestedSize || 0,
            ticketTier: decision.ticketTier || '',
        });
    }
}

export class ProportionalSizingNode extends BaseSizingNode {
    constructor() {
        super('copytrade.proportional.sizing');
    }

    protected evaluate(ctx: NodeContext<CopyTradeWorkflowState>) {
        return computeProportionalDecision(
            ctx.state.sourceEvent!,
            Math.max(Number(ctx.state.portfolio?.cashBalance) || 0, 0),
            Math.max(Number(ctx.state.localPosition?.size) || 0, 0),
            ctx.runtime.config
        );
    }
}

export class FixedAmountSizingNode extends BaseSizingNode {
    constructor() {
        super('copytrade.fixed_amount.sizing');
    }

    protected evaluate(ctx: NodeContext<CopyTradeWorkflowState>) {
        return computeFixedAmountDecision(
            ctx.state.sourceEvent!,
            Math.max(Number(ctx.state.portfolio?.cashBalance) || 0, 0),
            Math.max(Number(ctx.state.localPosition?.size) || 0, 0),
            ctx.runtime.config
        );
    }
}

export class SignalSizingNode extends BaseSizingNode {
    constructor() {
        super('copytrade.signal.sizing');
    }

    protected evaluate(ctx: NodeContext<CopyTradeWorkflowState>) {
        return computeSignalDecision(
            ctx.state.sourceEvent!,
            Math.max(Number(ctx.state.portfolio?.cashBalance) || 0, 0),
            Math.max(Number(ctx.state.localPosition?.size) || 0, 0),
            ctx.runtime.config
        );
    }
}
