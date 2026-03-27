import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import { BaseNode } from '../kernel/BaseNode';

export class SettlementSweepNode extends BaseNode {
    constructor() {
        super('settlement.sweep');
    }

    async doAction(ctx: NodeContext): Promise<NodeResult> {
        await ctx.runtime.gateways.settlement.runDue();
        return this.success(undefined, null, '结算轮次执行完成');
    }
}
