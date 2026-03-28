import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { MonitorWorkflowState } from './workflowState';
import { buildCopyTradeDispatchItems } from '../../../utils/copytradeDispatch';
import { MonitorNode } from './MonitorNode';

export class PrepareDispatchBundlesNode extends MonitorNode<MonitorWorkflowState> {
    constructor() {
        super('monitor.aggregate');
    }

    async doAction(ctx: NodeContext<MonitorWorkflowState>): Promise<NodeResult> {
        const retryEvents = await ctx.runtime.stores.sourceEvents.claimDueRetries(
            ctx.now(),
            ctx.runtime.config.activitySyncLimit,
            {
                processingLeaseMs: ctx.runtime.config.copytradeProcessingLeaseMs,
                maxRetryCount: ctx.runtime.config.maxRetryCount,
            }
        );
        const dispatchItems = buildCopyTradeDispatchItems({
            events: [...(ctx.state.newEvents || []), ...retryEvents],
            strategyKind: ctx.runtime.config.strategyKind,
            mergeWindowMs: ctx.runtime.config.activityAdjacentMergeWindowMs,
        });
        ctx.state.dispatchItems = dispatchItems;

        return this.success({
            newEvents: (ctx.state.newEvents || []).length,
            retryEvents: retryEvents.length,
            dispatches: dispatchItems.length,
        });
    }
}
