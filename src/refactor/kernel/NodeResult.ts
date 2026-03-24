export type NodeResultStatus = 'success' | 'skip' | 'retry' | 'fail';

export interface NodeResult<TPayload = unknown> {
    status: NodeResultStatus;
    reason?: string;
    payload?: TPayload;
    next?: string | null;
    delayMs?: number;
    metrics?: Record<string, number>;
}

export interface NodeRoute {
    next?: string | null;
    stop?: boolean;
}
