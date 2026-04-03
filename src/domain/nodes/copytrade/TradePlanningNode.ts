import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';
import {
    buildTradeExecutionRequest,
    resolveTradePlanning,
} from '@domain/nodes/copytrade/tradePlanning';

export class TradePlanningNode extends CopyTradeNode {
    constructor() {
        super('copytrade.trade.plan');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const planning = resolveTradePlanning(ctx);
        if (planning.status === 'skip') {
            return this.skip(planning.reason, 'copytrade.persist');
        }
        if (planning.status === 'retry') {
            return this.retry(planning.reason, planning.delayMs, 'copytrade.persist');
        }

        ctx.state.tradeExecutionRequest = buildTradeExecutionRequest(ctx, planning.value);
        return this.success({
            requestedUsdc: ctx.state.tradeExecutionRequest.requestedUsdc,
            orderAmount: ctx.state.tradeExecutionRequest.orderAmount,
            executionPrice: ctx.state.tradeExecutionRequest.executionPrice,
        });
    }
}
