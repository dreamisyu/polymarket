import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { NodeWorkflowEngine } from '../kernel/NodeWorkflowEngine';
import type { NodeWorkflowDefinition } from '../kernel/NodeChainBuilder';
import type { SourceTradeEvent } from '../..';
import type { MonitorWorkflowState } from './workflowState';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { MonitorNode } from './MonitorNode';

interface CopyTradeContextBuilder {
    (event: SourceTradeEvent, parentCtx: NodeContext<MonitorWorkflowState>): NodeContext<CopyTradeWorkflowState>;
}

export class DispatchCopyTradeNode extends MonitorNode<MonitorWorkflowState> {
    private readonly engine: NodeWorkflowEngine;
    private readonly workflow: NodeWorkflowDefinition;
    private readonly buildCopyTradeContext: CopyTradeContextBuilder;

    constructor(params: {
        engine: NodeWorkflowEngine;
        workflow: NodeWorkflowDefinition;
        buildCopyTradeContext: CopyTradeContextBuilder;
    }) {
        super('monitor.dispatch');
        this.engine = params.engine;
        this.workflow = params.workflow;
        this.buildCopyTradeContext = params.buildCopyTradeContext;
    }

    async doAction(ctx: NodeContext<MonitorWorkflowState>): Promise<NodeResult> {
        const executableEvents = (ctx.state.newEvents || []).filter(
            (event) => event.executionIntent === 'EXECUTE'
        );
        if (executableEvents.length === 0) {
            return this.skip('本轮没有待派发的可执行源事件', null);
        }

        for (const event of executableEvents) {
            const childCtx = this.buildCopyTradeContext(event, ctx);
            this.engine.runDetached(childCtx, this.workflow);
        }

        return this.success({ dispatched: executableEvents.length });
    }
}
