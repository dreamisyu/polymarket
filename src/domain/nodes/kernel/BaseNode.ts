import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { Node } from '@domain/nodes/kernel/Node';
import type { NodeResult, NodeRoute } from '@domain/nodes/kernel/NodeResult';

export abstract class BaseNode<
    TState extends Record<string, unknown> = Record<string, unknown>,
> implements Node<TState> {
    readonly id: string;

    constructor(id: string) {
        this.id = id;
    }

    protected success(payload?: unknown, next?: string | null, reason = ''): NodeResult {
        return { status: 'success', payload, next, reason };
    }

    protected skip(reason: string, next?: string | null): NodeResult {
        return { status: 'skip', reason, next };
    }

    protected retry(reason: string, delayMs?: number, next?: string | null): NodeResult {
        return { status: 'retry', reason, delayMs, next };
    }

    protected fail(reason: string, next?: string | null): NodeResult {
        return { status: 'fail', reason, next };
    }

    protected getLogger(ctx: NodeContext<TState>) {
        return ctx.runtime.logger;
    }

    abstract doAction(ctx: NodeContext<TState>): Promise<NodeResult>;

    route(_ctx: NodeContext<TState>, result: NodeResult): NodeRoute {
        return {
            next: result.next,
            stop: result.next === null,
        };
    }
}
