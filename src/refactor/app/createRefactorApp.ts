import { sleep } from '../utils/sleep';
import { NodeChainBuilder } from '../kernel/NodeChainBuilder';
import { NodeRegistry } from '../kernel/NodeRegistry';
import { NodeWorkflowEngine } from '../kernel/NodeWorkflowEngine';
import type { NodeContext } from '../kernel/NodeContext';
import { FetchMonitorEventsNode } from '../nodes/monitor/FetchMonitorEventsNode';
import { PersistMonitorEventsNode } from '../nodes/monitor/PersistMonitorEventsNode';
import { DispatchCopyTradeNode } from '../nodes/monitor/DispatchCopyTradeNode';
import type { MonitorWorkflowState } from '../nodes/monitor/workflowState';
import { SettlementSweepNode } from '../nodes/settlement/SettlementSweepNode';
import type { SourceTradeEvent } from '../domain';
import { createStrategy } from '../strategy/createStrategy';
import type { CopyTradeWorkflowState } from '../strategy/workflowState';
import type { StrategyBuildResult } from '../strategy/types';
import type { RefactorRuntime } from '../infrastructure/runtime/contracts';

export interface WorkflowWorker {
    name: string;
    run: () => Promise<void>;
}

export interface RefactorApp {
    workers: WorkflowWorker[];
    strategy: StrategyBuildResult;
}

const buildContext = <TState extends Record<string, unknown>>(
    runtime: RefactorRuntime,
    workflowKind: 'monitor' | 'copytrade' | 'settlement',
    state: TState,
    options: {
        workflowId?: string;
        parentWorkflowId?: string;
        dispatchReason?: string;
        dispatchId?: string;
    } = {}
): NodeContext<TState> => ({
    workflowId: options.workflowId || `${workflowKind}:${runtime.config.strategyKind}`,
    workflowKind,
    runMode: runtime.config.runMode,
    strategyKind: workflowKind === 'copytrade' ? runtime.config.strategyKind : undefined,
    parentWorkflowId: options.parentWorkflowId,
    dispatchReason: options.dispatchReason,
    dispatchId: options.dispatchId,
    runtime,
    state,
    startedAt: Date.now(),
    now: () => Date.now(),
});

const createLoopWorker = (params: {
    name: string;
    intervalMs: number;
    runOnce: () => Promise<void>;
}) => ({
    name: params.name,
    run: async () => {
        while (true) {
            await params.runOnce();
            await sleep(params.intervalMs);
        }
    },
});

export const createRefactorApp = (runtime: RefactorRuntime): RefactorApp => {
    const registry = new NodeRegistry();
    const engine = new NodeWorkflowEngine(registry);
    const strategy = createStrategy(runtime.config.strategyKind).build(registry);

    const buildCopyTradeContext = (
        event: SourceTradeEvent,
        parentCtx: NodeContext<MonitorWorkflowState>
    ): NodeContext<CopyTradeWorkflowState> =>
        buildContext(
            runtime,
            'copytrade',
            {
                sourceEvent: event,
                portfolio: undefined,
                localPosition: undefined,
                conditionPositions: undefined,
                sizingDecision: undefined,
                executionResult: undefined,
                policyTrail: [],
            },
            {
                workflowId: `copytrade:${runtime.config.strategyKind}:${event.activityKey}`,
                parentWorkflowId: parentCtx.workflowId,
                dispatchReason: 'monitor-dispatch',
                dispatchId: event.activityKey,
            }
        );

    registry.register(new FetchMonitorEventsNode());
    registry.register(new PersistMonitorEventsNode());
    registry.register(
        new DispatchCopyTradeNode({
            engine,
            workflow: strategy.workflow,
            buildCopyTradeContext,
        })
    );
    registry.register(new SettlementSweepNode());

    const monitorWorkflow = new NodeChainBuilder()
        .append('monitor.fetch')
        .append('monitor.persist')
        .append('monitor.dispatch')
        .build();
    const settlementWorkflow = new NodeChainBuilder().append('settlement.sweep').build();

    return {
        strategy,
        workers: [
            createLoopWorker({
                name: '监控分发工作流',
                intervalMs: runtime.config.monitorIntervalMs,
                runOnce: async () => {
                    await engine.run(buildContext(runtime, 'monitor', {} as MonitorWorkflowState), monitorWorkflow);
                },
            }),
            createLoopWorker({
                name: '结算工作流',
                intervalMs: runtime.config.settlementIntervalMs,
                runOnce: async () => {
                    await engine.run(buildContext(runtime, 'settlement', {}), settlementWorkflow);
                },
            }),
        ],
    };
};
