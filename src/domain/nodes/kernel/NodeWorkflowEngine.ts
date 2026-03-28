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
    private readonly detachedConcurrency: number;
    private readonly detachedQueue: Array<{
        ctx: NodeContext<Record<string, unknown>>;
        workflow: NodeWorkflowDefinition;
    }> = [];
    private activeDetachedRuns = 0;

    constructor(registry: NodeRegistry, options: { detachedConcurrency?: number } = {}) {
        this.registry = registry;
        this.detachedConcurrency = Math.max(
            options.detachedConcurrency || Number.POSITIVE_INFINITY,
            1
        );
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
            const nextNodeId =
                route.next !== undefined
                    ? route.next
                    : result.next !== undefined
                      ? result.next
                      : fallbackNext;

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

    runDetached<TState extends Record<string, unknown>>(
        ctx: NodeContext<TState>,
        workflow: NodeWorkflowDefinition
    ) {
        this.detachedQueue.push({
            ctx: ctx as NodeContext<Record<string, unknown>>,
            workflow,
        });
        this.drainDetachedQueue();
    }

    private drainDetachedQueue() {
        while (
            this.activeDetachedRuns < this.detachedConcurrency &&
            this.detachedQueue.length > 0
        ) {
            const next = this.detachedQueue.shift();
            if (!next) {
                return;
            }

            this.activeDetachedRuns += 1;
            void this.run(next.ctx, next.workflow)
                .catch((error) => {
                    next.ctx.runtime.logger.error(
                        {
                            workflowId: next.ctx.workflowId,
                            workflowKind: next.ctx.workflowKind,
                            parentWorkflowId: next.ctx.parentWorkflowId,
                            dispatchId: next.ctx.dispatchId,
                        },
                        '异步子工作流执行失败'
                    );
                    next.ctx.runtime.logger.error(error);
                })
                .finally(() => {
                    this.activeDetachedRuns = Math.max(this.activeDetachedRuns - 1, 0);
                    this.drainDetachedQueue();
                });
        }
    }
}
