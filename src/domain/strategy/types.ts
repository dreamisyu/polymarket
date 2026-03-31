import type {
    NodeChainBuilder,
    NodeWorkflowDefinition,
} from '@domain/nodes/kernel/NodeChainBuilder';
import type { StrategyKind } from '@domain';

export interface StrategyBuildResult {
    strategyKind: StrategyKind;
    headNodeId: string;
    entryNodeId: string;
    workflow: NodeWorkflowDefinition;
}

export interface Strategy {
    readonly name: StrategyKind;
    readonly entryNodeId: string;
    build(): StrategyBuildResult;
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
