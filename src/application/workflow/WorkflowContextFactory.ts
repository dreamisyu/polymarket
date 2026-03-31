import type { CopyTradeDispatchItem } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { MonitorWorkflowState } from '@domain/nodes/monitor/workflowState';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import type { Runtime } from '@infrastructure/runtime/contracts';

export default class WorkflowContextFactory {
    constructor(private readonly deps: { runtime: Runtime }) {}

    createMonitorContext(): NodeContext<MonitorWorkflowState> {
        return this.buildContext('monitor', {} as MonitorWorkflowState);
    }

    createSettlementContext(): NodeContext<Record<string, never>> {
        return this.buildContext('settlement', {} as Record<string, never>);
    }

    createCopyTradeContext(
        dispatchItem: CopyTradeDispatchItem,
        parentCtx: NodeContext<MonitorWorkflowState>
    ): NodeContext<CopyTradeWorkflowState> {
        return this.buildContext(
            'copytrade',
            {
                sourceEvent: dispatchItem.sourceEvent,
                sourceEvents: dispatchItem.sourceEvents,
                portfolio: undefined,
                localPosition: undefined,
                conditionPositions: undefined,
                sizingDecision: undefined,
                executionResult: undefined,
                policyTrail: [],
            },
            {
                workflowId: `copytrade:${this.deps.runtime.config.strategyKind}:${dispatchItem.dispatchId}`,
                parentWorkflowId: parentCtx.workflowId,
                dispatchReason: dispatchItem.aggregated
                    ? 'monitor-bundle-dispatch'
                    : 'monitor-dispatch',
                dispatchId: dispatchItem.dispatchId,
            }
        );
    }

    private buildContext<TState extends Record<string, unknown>>(
        workflowKind: 'monitor' | 'copytrade' | 'settlement',
        state: TState,
        options: {
            workflowId?: string;
            parentWorkflowId?: string;
            dispatchReason?: string;
            dispatchId?: string;
        } = {}
    ): NodeContext<TState> {
        return {
            workflowId:
                options.workflowId || `${workflowKind}:${this.deps.runtime.config.strategyKind}`,
            workflowKind,
            runMode: this.deps.runtime.config.runMode,
            strategyKind:
                workflowKind === 'copytrade' ? this.deps.runtime.config.strategyKind : undefined,
            parentWorkflowId: options.parentWorkflowId,
            dispatchReason: options.dispatchReason,
            dispatchId: options.dispatchId,
            runtime: this.deps.runtime,
            state,
            startedAt: Date.now(),
            now: () => Date.now(),
        };
    }
}
