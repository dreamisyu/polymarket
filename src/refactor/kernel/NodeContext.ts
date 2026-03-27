import type { RefactorRuntime } from '../infrastructure/runtime/contracts';
import type { RunMode, StrategyKind, WorkflowKind } from '../domain/types';

export interface NodeContext<TState extends Record<string, unknown> = Record<string, unknown>> {
    workflowId: string;
    workflowKind: WorkflowKind;
    runMode: RunMode;
    strategyKind?: StrategyKind;
    parentWorkflowId?: string;
    dispatchReason?: string;
    dispatchId?: string;
    runtime: RefactorRuntime;
    state: TState;
    startedAt: number;
    now: () => number;
}
