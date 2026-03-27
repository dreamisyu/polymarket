import type { NodeContext } from './NodeContext';
import type { NodeResult, NodeRoute } from './NodeResult';

export interface Node<TState extends Record<string, unknown> = Record<string, unknown>> {
    readonly id: string;
    doAction(ctx: NodeContext<TState>): Promise<NodeResult>;
    route(ctx: NodeContext<TState>, result: NodeResult): Promise<NodeRoute> | NodeRoute;
}
