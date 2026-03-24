import type { NodeResultStatus } from './NodeResult';

interface NodeTransitionMap {
    success?: string | null;
    skip?: string | null;
    retry?: string | null;
    fail?: string | null;
}

export interface NodeWorkflowDefinition {
    headNodeId: string;
    transitions: Map<string, NodeTransitionMap>;
}

export interface NodeExtensionDefinition {
    targetNodeId: string;
    placement: 'before' | 'after';
    nodeId: string;
}

const DEFAULT_STATUSES: NodeResultStatus[] = ['success', 'skip', 'retry', 'fail'];

export class NodeChainBuilder {
    private readonly nodes: string[] = [];
    private readonly explicitTransitions = new Map<string, NodeTransitionMap>();
    private readonly extensions: NodeExtensionDefinition[] = [];

    append(nodeId: string) {
        this.nodes.push(nodeId);
        return this;
    }

    before(targetNodeId: string, nodeId: string) {
        this.extensions.push({ targetNodeId, placement: 'before', nodeId });
        return this;
    }

    after(targetNodeId: string, nodeId: string) {
        this.extensions.push({ targetNodeId, placement: 'after', nodeId });
        return this;
    }

    setTransition(nodeId: string, status: NodeResultStatus, next: string | null) {
        const current = this.explicitTransitions.get(nodeId) || {};
        current[status] = next;
        this.explicitTransitions.set(nodeId, current);
        return this;
    }

    build(): NodeWorkflowDefinition {
        const expanded = this.expandNodes();
        if (expanded.length === 0) {
            throw new Error('工作流至少需要一个节点');
        }

        const transitions = new Map<string, NodeTransitionMap>();
        for (let index = 0; index < expanded.length; index += 1) {
            const currentNodeId = expanded[index];
            const nextNodeId = expanded[index + 1] || null;
            const explicit = this.explicitTransitions.get(currentNodeId) || {};
            const nextMap: NodeTransitionMap = {};
            for (const status of DEFAULT_STATUSES) {
                nextMap[status] = explicit[status] !== undefined ? explicit[status] : nextNodeId;
            }
            transitions.set(currentNodeId, nextMap);
        }

        return {
            headNodeId: expanded[0],
            transitions,
        };
    }

    private expandNodes() {
        const result: string[] = [];

        for (const nodeId of this.nodes) {
            const beforeNodes = this.extensions
                .filter((extension) => extension.targetNodeId === nodeId && extension.placement === 'before')
                .map((extension) => extension.nodeId);
            const afterNodes = this.extensions
                .filter((extension) => extension.targetNodeId === nodeId && extension.placement === 'after')
                .map((extension) => extension.nodeId);

            result.push(...beforeNodes, nodeId, ...afterNodes);
        }

        return result;
    }
}
