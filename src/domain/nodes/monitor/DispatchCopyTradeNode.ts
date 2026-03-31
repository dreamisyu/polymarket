import type { CopyTradeDispatchItem } from '@domain';
import type { NodeWorkflowDefinition } from '@domain/nodes/kernel/NodeChainBuilder';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { NodeWorkflowEngine } from '@domain/nodes/kernel/NodeWorkflowEngine';
import { MonitorNode } from '@domain/nodes/monitor/MonitorNode';
import type { MonitorWorkflowState } from '@domain/nodes/monitor/workflowState';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';

interface CopyTradeContextBuilder {
    (
        dispatchItem: CopyTradeDispatchItem,
        parentCtx: NodeContext<MonitorWorkflowState>
    ): NodeContext<CopyTradeWorkflowState>;
}

type WorkflowEngineResolver = () => NodeWorkflowEngine;
type WorkflowResolver = () => NodeWorkflowDefinition;

export class DispatchCopyTradeNode extends MonitorNode<MonitorWorkflowState> {
    private readonly resolveEngine: WorkflowEngineResolver;
    private readonly resolveWorkflow: WorkflowResolver;
    private readonly buildCopyTradeContext: CopyTradeContextBuilder;

    constructor(params: {
        resolveEngine: WorkflowEngineResolver;
        resolveWorkflow: WorkflowResolver;
        buildCopyTradeContext: CopyTradeContextBuilder;
    }) {
        super('monitor.dispatch');
        this.resolveEngine = params.resolveEngine;
        this.resolveWorkflow = params.resolveWorkflow;
        this.buildCopyTradeContext = params.buildCopyTradeContext;
    }

    async doAction(ctx: NodeContext<MonitorWorkflowState>): Promise<NodeResult> {
        const dispatchItems = ctx.state.dispatchItems || [];
        if (dispatchItems.length === 0) {
            return this.skip('本轮没有待派发的可执行源事件', null);
        }

        for (const dispatchItem of dispatchItems) {
            const childCtx = this.buildCopyTradeContext(dispatchItem, ctx);
            this.resolveEngine().runDetached(childCtx, this.resolveWorkflow());
        }

        return this.success({ dispatched: dispatchItems.length });
    }
}
