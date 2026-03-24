import type { NodeRegistry } from './NodeRegistry';
import type { NodeContext } from './NodeContext';
import type { NodeWorkflowDefinition } from './NodeChainBuilder';
import type { NodeResult } from './NodeResult';

export interface WorkflowRunSummary {
    lastNodeId: string | null;
    lastResult: NodeResult | null;
    visitedNodeIds: string[];
}

export class NodeWorkflowEngine {
    private readonly registry: NodeRegistry;

    constructor(registry: NodeRegistry) {
        this.registry = registry;
    }

    async run<TState extends Record<string, unknown>>(
        ctx: NodeContext<TState>,
        workflow: NodeWorkflowDefinition
    ): Promise<WorkflowRunSummary> {
        let currentNodeId: string | null = workflow.headNodeId;
        let lastNodeId: string | null = null;
        let lastResult: NodeResult | null = null;
        const visitedNodeIds: string[] = [];

        while (currentNodeId) {
            const node = this.registry.resolve(currentNodeId);
            const result = await node.doAction(ctx);
            const route = await node.route(ctx, result);
            const transition = workflow.transitions.get(currentNodeId) || {};
            const fallbackNext = transition[result.status] ?? null;
            const nextNodeId = route.next !== undefined ? route.next : result.next !== undefined ? result.next : fallbackNext;

            visitedNodeIds.push(currentNodeId);
            lastNodeId = currentNodeId;
            lastResult = result;

            if (route.stop || nextNodeId === null) {
                break;
            }

            currentNodeId = nextNodeId;
        }

        return {
            lastNodeId,
            lastResult,
            visitedNodeIds,
        };
    }
}
