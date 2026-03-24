import type { NodeContext } from '../../kernel/NodeContext';
import type { NodeResult } from '../../kernel/NodeResult';
import { MonitorNode } from './MonitorNode';

export class LegacyMonitorNode extends MonitorNode {
    constructor() {
        super('monitor.legacy');
    }

    async doAction(ctx: NodeContext): Promise<NodeResult> {
        const logger = this.getLogger(ctx);
        await ctx.runtime.gateways.monitor.start(async (events) => {
            await ctx.runtime.stores.sourceEvents.upsertMany(events);
            if (events.length > 0) {
                logger.debug(`监控链路同步 ${events.length} 条活动`);
            }
        });

        return this.success(undefined, null, '监控链路已停止');
    }
}
