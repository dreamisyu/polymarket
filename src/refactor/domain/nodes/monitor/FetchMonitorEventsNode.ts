import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { MonitorWorkflowState } from './workflowState';
import { MonitorNode } from './MonitorNode';

export class FetchMonitorEventsNode extends MonitorNode<MonitorWorkflowState> {
    constructor() {
        super('monitor.fetch');
    }

    async doAction(ctx: NodeContext<MonitorWorkflowState>): Promise<NodeResult> {
        const syncResult = await ctx.runtime.gateways.monitor.syncOnce();
        ctx.state.syncResult = syncResult;
        ctx.state.newEvents = [];
        return this.success({ fetched: syncResult.events.length, syncedAt: syncResult.syncedAt });
    }
}
