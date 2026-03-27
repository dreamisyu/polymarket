import { sleep } from '../utils/sleep';
import { NodeChainBuilder } from '../domain/nodes/kernel/NodeChainBuilder';
import { NodeRegistry } from '../domain/nodes/kernel/NodeRegistry';
import { NodeWorkflowEngine } from '../domain/nodes/kernel/NodeWorkflowEngine';
import type { NodeContext } from '../domain/nodes/kernel/NodeContext';
import { FetchMonitorEventsNode } from '../domain/nodes/monitor/FetchMonitorEventsNode';
import { PersistMonitorEventsNode } from '../domain/nodes/monitor/PersistMonitorEventsNode';
import { DispatchCopyTradeNode } from '../domain/nodes/monitor/DispatchCopyTradeNode';
import type { MonitorWorkflowState } from '../domain/nodes/monitor/workflowState';
import { SettlementSweepNode } from '../domain/nodes/settlement/SettlementSweepNode';
import type { SourceTradeEvent } from '../domain';
import { createStrategy } from '../domain/strategy/createStrategy';
import type { CopyTradeWorkflowState } from '../domain/strategy/workflowState';
import type { StrategyBuildResult } from '../domain/strategy/types';
import type { Runtime } from '../infrastructure/runtime/contracts';

export interface WorkflowWorker {
    name: string;
    run: () => Promise<void>;
}

export interface App {
    workers: WorkflowWorker[];
    strategy: StrategyBuildResult;
}

const buildContext = <TState extends Record<string, unknown>>(
    runtime: Runtime,
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

export const createApp = (runtime: Runtime): App => {
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
