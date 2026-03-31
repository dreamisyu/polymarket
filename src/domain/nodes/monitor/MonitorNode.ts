import { BaseNode } from '@domain/nodes/kernel/BaseNode';

export abstract class MonitorNode<
    TState extends Record<string, unknown> = Record<string, unknown>,
> extends BaseNode<TState> {}
