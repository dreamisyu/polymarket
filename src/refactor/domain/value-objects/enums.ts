export type RunMode = 'live' | 'paper';
export type StrategyKind = 'signal' | 'fixed_amount' | 'proportional';
export type WorkflowKind = 'monitor' | 'copytrade' | 'settlement';
export type SourceEventStatus = 'pending' | 'processing' | 'retry' | 'confirmed' | 'skipped' | 'failed';
export type WorkflowExecutionStatus =
    | 'ready'
    | 'submitted'
    | 'confirmed'
    | 'skipped'
    | 'retry'
    | 'failed';
export type TradeAction = 'buy' | 'sell' | 'merge' | 'redeem';
export type ExecutionIntent = 'EXECUTE' | 'SYNC_ONLY';
export type SnapshotStatus = 'COMPLETE' | 'PARTIAL' | 'STALE';
export type SettlementTaskStatus = 'pending' | 'processing' | 'settled' | 'closed';
export type StrategyTicketTier = 'weak' | 'normal' | 'strong';
