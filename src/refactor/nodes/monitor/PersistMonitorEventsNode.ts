import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import type { MonitorWorkflowState } from './workflowState';
import { MonitorNode } from './MonitorNode';

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
