import type { NodeWorkflowDefinition } from '@domain/nodes/kernel/NodeChainBuilder';
import type { ExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { StrategyKind } from '@domain/value-objects/enums';

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    workflow: NodeWorkflowDefinition;
}

export interface Strategy {
    readonly name: StrategyKind;
    readonly persistencePlanner: ExecutionPersistencePlanner;
    buildWorkflow(): NodeWorkflowDefinition;
    resolveBuyNode(): string;
    resolveSellNode(): string;
    resolveMergeNode(): string;
    resolveRedeemNode(): string;
}

export const buildStrategyResult = (strategy: Strategy): StrategyBuildResult => ({
    strategyKind: strategy.name,
    workflow: strategy.buildWorkflow(),
});
