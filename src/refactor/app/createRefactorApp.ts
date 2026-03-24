import { sleep } from '../../utils/runtime';
import { NodeChainBuilder } from '../kernel/NodeChainBuilder';
import { NodeRegistry } from '../kernel/NodeRegistry';
import { NodeWorkflowEngine } from '../kernel/NodeWorkflowEngine';
import type { NodeContext } from '../kernel/NodeContext';
import { LegacyMonitorNode } from '../nodes/monitor/LegacyMonitorNode';
import { SettlementSweepNode } from '../nodes/settlement/SettlementSweepNode';
import { createStrategy } from '../strategy/createStrategy';
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

const buildContext = (
    runtime: RefactorRuntime,
    workflowKind: 'monitor' | 'copytrade' | 'settlement'
): NodeContext => ({
    workflowId: `${workflowKind}:${runtime.config.strategyKind}`,
    workflowKind,
    runMode: runtime.config.runMode,
    strategyKind: workflowKind === 'copytrade' ? runtime.config.strategyKind : undefined,
    runtime,
    state: {},
    startedAt: Date.now(),
    now: () => Date.now(),
});

const createLoopWorker = (params: {
    name: string;
    intervalMs: number;
    runtime: RefactorRuntime;
    engine: NodeWorkflowEngine;
    workflowKind: 'copytrade' | 'settlement';
    workflow: StrategyBuildResult['workflow'];
}) => ({
    name: params.name,
    run: async () => {
        while (true) {
            const summary = await params.engine.run(
                buildContext(params.runtime, params.workflowKind),
                params.workflow
            );
            const delayMs =
                summary.lastResult?.status === 'retry' && summary.lastResult.delayMs
                    ? summary.lastResult.delayMs
                    : params.intervalMs;
            await sleep(delayMs);
        }
    },
});

export const createRefactorApp = (runtime: RefactorRuntime): RefactorApp => {
    const registry = new NodeRegistry();
    const engine = new NodeWorkflowEngine(registry);

    registry.register(new LegacyMonitorNode());
    registry.register(new SettlementSweepNode());

    const strategy = createStrategy(runtime.config.strategyKind).build(registry);
    const monitorWorkflow = new NodeChainBuilder().append('monitor.legacy').build();
    const settlementWorkflow = new NodeChainBuilder().append('settlement.sweep').build();

    return {
        strategy,
        workers: [
            {
                name: '监控节点工作流',
                run: async () => {
                    await engine.run(buildContext(runtime, 'monitor'), monitorWorkflow);
                    throw new Error('监控工作流意外退出');
                },
            },
            createLoopWorker({
                name: `跟单策略工作流(${runtime.config.strategyKind})`,
                intervalMs: runtime.config.strategyLoopIntervalMs,
                runtime,
                engine,
                workflowKind: 'copytrade',
                workflow: strategy.workflow,
            }),
            createLoopWorker({
                name: '结算工作流',
                intervalMs: runtime.config.settlementLoopIntervalMs,
                runtime,
                engine,
                workflowKind: 'settlement',
                workflow: {
                    headNodeId: settlementWorkflow.headNodeId,
                    transitions: settlementWorkflow.transitions,
                },
            }),
        ],
    };
};
