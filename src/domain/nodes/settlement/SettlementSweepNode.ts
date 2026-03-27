import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import { BaseNode } from '../kernel/BaseNode';

export class SettlementSweepNode extends BaseNode {
    constructor() {
        super('settlement.sweep');
    }

    async doAction(ctx: NodeContext): Promise<NodeResult> {
        let handledCount = 0;
        const maxTasksPerRun = Math.max(ctx.runtime.config.settlementMaxTasksPerRun || 1, 1);

        while (handledCount < maxTasksPerRun) {
            const handled = await ctx.runtime.gateways.settlement.runDue();
            if (!handled) {
                break;
            }

            handledCount += 1;
        }

        const reason =
            handledCount > 0
                ? `结算轮次执行完成，处理 ${handledCount} 个任务`
                : '结算轮次执行完成，无到期任务';
        return this.success({ handledCount, maxTasksPerRun }, null, reason);
    }
}
