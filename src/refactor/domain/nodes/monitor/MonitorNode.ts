import { BaseNode } from '../kernel/BaseNode';

export abstract class MonitorNode<TState extends Record<string, unknown> = Record<string, unknown>> extends BaseNode<TState> {}
