import type {
    NodeChainBuilder,
    NodeWorkflowDefinition,
} from '@domain/nodes/kernel/NodeChainBuilder';
import type { ExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { StrategyKind, TradeAction } from '@domain/value-objects/enums';

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    workflow: NodeWorkflowDefinition;
}

export interface Strategy {
    readonly name: StrategyKind;
    readonly persistencePlanner: ExecutionPersistencePlanner;
    buildWorkflow(): NodeWorkflowDefinition;
    resolveActionNode(action: TradeAction): string | null;
}

export interface StrategyExtensionDefinition {
    targetNodeId: string;
    placement: 'before' | 'after';
    nodeId: string;
}

export const applyStrategyExtensions = (
    builder: NodeChainBuilder,
    extensions: StrategyExtensionDefinition[]
) => {
    for (const extension of extensions) {
        if (extension.placement === 'before') {
            builder.before(extension.targetNodeId, extension.nodeId);
            continue;
        }

        builder.after(extension.targetNodeId, extension.nodeId);
    }
};

export const buildStrategyResult = (strategy: Strategy): StrategyBuildResult => ({
    strategyKind: strategy.name,
    workflow: strategy.buildWorkflow(),
});
