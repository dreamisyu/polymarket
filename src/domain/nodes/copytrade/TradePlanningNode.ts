import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { resolveFixedAmountBundleExecution } from '@domain/strategy/copytradeDispatch';
import { buildChunkExecutionPlan } from '@domain/trading/executionPlanning';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';

export class TradePlanningNode extends CopyTradeNode {
    constructor() {
        super('copytrade.trade.plan');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const decision = ctx.state.sizingDecision;
        const portfolio = ctx.state.portfolio;
        const localPosition = ctx.state.localPosition;
        const marketSnapshot = ctx.state.marketSnapshot;
        ctx.state.tradeExecutionRequest = undefined;

        if (!event || !decision || decision.status !== 'ready' || !portfolio) {
            return this.skip('缺少交易规划所需上下文', 'copytrade.persist');
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
            return this.retry(
                ctx.state.executionResult.reason,
                ctx.runtime.config.retryBackoffMs,
                'copytrade.persist'
            );
        }

        const plan = buildChunkExecutionPlan({
            condition: event.action,
            trade: event,
            myPositionSize: Math.max(Number(localPosition?.size) || 0, 0),
            sourcePositionAfterTradeSize: Math.max(
                Number(event.sourcePositionSizeAfterTrade) || 0,
                0
            ),
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
            return this.skip(plan.reason, 'copytrade.persist');
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
            return this.retry(plan.reason, ctx.runtime.config.retryBackoffMs, 'copytrade.persist');
        }

        const bundleExecution = resolveFixedAmountBundleExecution({
            event,
            requestedUsdc: plan.requestedUsdc,
            executableUsdc: plan.orderAmount,
            fixedTradeAmountUsdc: ctx.runtime.config.fixedTradeAmountUsdc,
        });
        if (bundleExecution && bundleExecution.plannedCount <= 0) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '聚合买单在当前余额下不可执行',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: plan.executionPrice,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }
        if (bundleExecution && bundleExecution.executedCount <= 0) {
            ctx.state.executionResult = {
                status: 'retry',
                reason: '聚合买单未达到单笔最小金额，稍后重试',
                requestedUsdc: bundleExecution.requestedUsdc,
                requestedSize: plan.requestedSize,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: plan.executionPrice,
                orderIds: [],
                transactionHashes: [],
                metadata: {
                    bundlePlannedCount: bundleExecution.plannedCount,
                    bundleExecutedCount: 0,
                },
            };
            return this.retry(
                ctx.state.executionResult.reason,
                ctx.runtime.config.retryBackoffMs,
                'copytrade.persist'
            );
        }

        ctx.state.tradeExecutionRequest = {
            sourceEvent: event,
            sourceEvents: ctx.state.sourceEvents,
            requestedUsdc: bundleExecution?.requestedUsdc ?? plan.requestedUsdc,
            requestedSize: plan.requestedSize,
            orderAmount: bundleExecution?.executableUsdc ?? plan.orderAmount,
            executionPrice: plan.executionPrice,
            side: plan.side,
            tickSize: plan.tickSize,
            negRisk: plan.negRisk,
            note: plan.note || decision.note,
            workflowId: ctx.workflowId,
            policyTrail: ctx.state.policyTrail || [],
            metadata: bundleExecution
                ? {
                      bundlePlannedCount: bundleExecution.plannedCount,
                      bundleExecutedCount: bundleExecution.executedCount,
                  }
                : undefined,
        };

        return this.success({
            requestedUsdc: ctx.state.tradeExecutionRequest.requestedUsdc,
            orderAmount: ctx.state.tradeExecutionRequest.orderAmount,
            executionPrice: ctx.state.tradeExecutionRequest.executionPrice,
        });
    }
}
