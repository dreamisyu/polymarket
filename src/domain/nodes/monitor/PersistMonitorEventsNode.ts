import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { MonitorWorkflowState } from '@domain/nodes/monitor/workflowState';
import { MonitorNode } from '@domain/nodes/monitor/MonitorNode';

export class PersistMonitorEventsNode extends MonitorNode<MonitorWorkflowState> {
    constructor() {
        super('monitor.persist');
    }

    async doAction(ctx: NodeContext<MonitorWorkflowState>): Promise<NodeResult> {
        const events = ctx.state.syncResult?.events || [];
        const newEvents = await ctx.runtime.stores.sourceEvents.upsertMany(events);
        ctx.state.newEvents = newEvents;
        return this.success({ persisted: events.length, newEvents: newEvents.length });
    }
}
