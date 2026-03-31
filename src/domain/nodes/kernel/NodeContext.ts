import type { Runtime } from '@infrastructure/runtime/contracts';
import type { RunMode, StrategyKind, WorkflowKind } from '@domain';

export interface NodeContext<TState extends Record<string, unknown> = Record<string, unknown>> {
    workflowId: string;
    workflowKind: WorkflowKind;
    runMode: RunMode;
    strategyKind?: StrategyKind;
    parentWorkflowId?: string;
    dispatchReason?: string;
    dispatchId?: string;
    runtime: Runtime;
    state: TState;
    startedAt: number;
    now: () => number;
}
