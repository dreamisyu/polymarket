import type { TradeExecutionPersistenceContext, TradeExecutionRequest } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { buildChunkExecutionPlan } from '@domain/trading/executionPlanning';

interface ReadyTradeExecutionPlan {
    status: 'READY';
    reason: string;
    requestedSize: number;
    requestedUsdc: number;
    orderAmount: number;
    executionPrice: number;
    side: NonNullable<ReturnType<typeof buildChunkExecutionPlan>['side']>;
    tickSize: NonNullable<ReturnType<typeof buildChunkExecutionPlan>['tickSize']>;
    negRisk?: boolean;
    note?: string;
}

interface ReadySizingDecision {
    status: 'ready';
    requestedUsdc?: number;
    requestedSize?: number;
    reason: string;
    note?: string;
}

export interface PreparedTradePlanning {
    event: NonNullable<CopyTradeWorkflowState['sourceEvent']>;
    decision: ReadySizingDecision;
    executionPlan: ReadyTradeExecutionPlan;
}

export type TradePlanningResolution =
    | {
          status: 'ready';
          value: PreparedTradePlanning;
      }
    | {
          status: 'skip';
          reason: string;
      }
    | {
          status: 'retry';
          reason: string;
          delayMs: number;
      };

export const resolveTradePlanning = (
    ctx: NodeContext<CopyTradeWorkflowState>
): TradePlanningResolution => {
    const event = ctx.state.sourceEvent;
    const decision = ctx.state.sizingDecision;
    const portfolio = ctx.state.portfolio;
    const localPosition = ctx.state.localPosition;
    const marketSnapshot = ctx.state.marketSnapshot;
    ctx.state.tradeExecutionRequest = undefined;

    if (!event || !decision || decision.status !== 'ready' || !portfolio) {
        return {
            status: 'skip',
            reason: '缺少交易规划所需上下文',
        };
    }

    if (!marketSnapshot) {
        ctx.state.executionResult = {
            status: 'retry',
            reason: '市场盘口不可用，稍后重试',
            requestedUsdc: decision.requestedUsdc || 0,
            requestedSize: decision.requestedSize || 0,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: 0,
            orderIds: [],
            transactionHashes: [],
        };
        return {
            status: 'retry',
            reason: ctx.state.executionResult.reason,
            delayMs: ctx.runtime.config.retryBackoffMs,
        };
    }

    const plan = buildChunkExecutionPlan({
        condition: event.action,
        trade: event,
        myPositionSize: Math.max(Number(localPosition?.size) || 0, 0),
        sourcePositionAfterTradeSize: Math.max(Number(event.sourcePositionSizeAfterTrade) || 0, 0),
        availableBalance: Math.max(Number(portfolio.cashBalance) || 0, 0),
        marketSnapshot,
        config: ctx.runtime.config,
        requestedUsdcOverride: decision.requestedUsdc,
        requestedSizeOverride: decision.requestedSize,
        sourcePriceOverride: event.price,
        noteOverride: decision.note,
    });

    if (plan.status === 'SKIPPED') {
        ctx.state.executionResult = {
            status: 'skipped',
            reason: plan.reason,
            requestedUsdc: plan.requestedUsdc,
            requestedSize: plan.requestedSize,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: plan.executionPrice,
            orderIds: [],
            transactionHashes: [],
        };
        return {
            status: 'skip',
            reason: plan.reason,
        };
    }

    if (plan.status !== 'READY' || !plan.side || !plan.tickSize) {
        ctx.state.executionResult = {
            status: 'retry',
            reason: plan.reason,
            requestedUsdc: plan.requestedUsdc,
            requestedSize: plan.requestedSize,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: plan.executionPrice,
            orderIds: [],
            transactionHashes: [],
        };
        return {
            status: 'retry',
            reason: plan.reason,
            delayMs: ctx.runtime.config.retryBackoffMs,
        };
    }

    return {
        status: 'ready',
        value: {
            event,
            decision,
            executionPlan: {
                ...plan,
                side: plan.side,
                tickSize: plan.tickSize,
            },
        },
    };
};

export const buildTradeExecutionRequest = (
    ctx: NodeContext<CopyTradeWorkflowState>,
    planning: PreparedTradePlanning,
    overrides: Partial<
        Pick<
            TradeExecutionRequest,
            | 'requestedUsdc'
            | 'requestedSize'
            | 'orderAmount'
            | 'note'
            | 'persistenceContext'
        >
    > = {}
): TradeExecutionRequest => ({
    sourceEvent: planning.event,
    sourceEvents: ctx.state.sourceEvents,
    requestedUsdc: overrides.requestedUsdc ?? planning.executionPlan.requestedUsdc,
    requestedSize: overrides.requestedSize ?? planning.executionPlan.requestedSize,
    orderAmount: overrides.orderAmount ?? planning.executionPlan.orderAmount,
    executionPrice: planning.executionPlan.executionPrice,
    side: planning.executionPlan.side,
    tickSize: planning.executionPlan.tickSize,
    negRisk: planning.executionPlan.negRisk,
    note: overrides.note ?? planning.executionPlan.note ?? planning.decision.note,
    workflowId: ctx.workflowId,
    policyTrail: ctx.state.policyTrail || [],
    persistenceContext: overrides.persistenceContext,
});

export const buildBundlePersistenceContext = (
    items: NonNullable<TradeExecutionPersistenceContext['bundle']>['items']
): TradeExecutionPersistenceContext => ({
    bundle: {
        items,
    },
});
