import type { NodeChainBuilder, NodeWorkflowDefinition } from '../kernel/NodeChainBuilder';
import type { NodeRegistry } from '../kernel/NodeRegistry';
import type { StrategyKind } from '../domain';

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    headNodeId: string;
    workflow: NodeWorkflowDefinition;
}

export interface Strategy {
    readonly name: StrategyKind;
    build(registry: NodeRegistry): StrategyBuildResult;
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
