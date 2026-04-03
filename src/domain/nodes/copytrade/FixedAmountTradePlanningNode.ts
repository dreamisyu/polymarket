import type { BundlePersistenceItem } from '@domain';
import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';
import {
    buildBundlePersistenceContext,
    buildTradeExecutionRequest,
    resolveTradePlanning,
} from '@domain/nodes/copytrade/tradePlanning';
import { resolveFixedAmountBundleExecution } from '@domain/strategy/copytradeDispatch';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';

const partialBundleReason = '聚合买单仅部分成交，剩余批次稍后重试';
const deferredBundleReason = '聚合买单受余额或风控限制，剩余批次顺延到下一轮';

const buildFixedAmountBundleItems = (params: {
    sourceEvents: NonNullable<CopyTradeWorkflowState['sourceEvents']>;
    executionPrice: number;
    fixedTradeAmountUsdc: number;
    plannedCount: number;
    executedCount: number;
}): BundlePersistenceItem[] => {
    const perTradeUsdc = Math.max(params.fixedTradeAmountUsdc, 0);
    const perTradeSize = params.executionPrice > 0 ? perTradeUsdc / params.executionPrice : 0;

    return params.sourceEvents.map((event, index) => ({
        activityKey: event.activityKey,
        requestedUsdc: index < params.plannedCount ? perTradeUsdc : 0,
        requestedSize: index < params.plannedCount ? perTradeSize : 0,
        submittedUsdc: index < params.executedCount ? perTradeUsdc : 0,
        submittedSize: index < params.executedCount ? perTradeSize : 0,
        deferredReason: index < params.plannedCount ? partialBundleReason : deferredBundleReason,
    }));
};

export class FixedAmountTradePlanningNode extends CopyTradeNode {
    constructor() {
        super('copytrade.fixed_amount.trade.plan');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const planning = resolveTradePlanning(ctx);
        if (planning.status === 'skip') {
            return this.skip(planning.reason, 'copytrade.persist');
        }
        if (planning.status === 'retry') {
            return this.retry(planning.reason, planning.delayMs, 'copytrade.persist');
        }

        const sourceEvents =
            ctx.state.sourceEvents && ctx.state.sourceEvents.length > 0
                ? ctx.state.sourceEvents
                : [planning.value.event];
        const bundleExecution = resolveFixedAmountBundleExecution({
            event: planning.value.event,
            requestedUsdc: planning.value.executionPlan.requestedUsdc,
            executableUsdc: planning.value.executionPlan.orderAmount,
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
                executionPrice: planning.value.executionPlan.executionPrice,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        const persistenceContext = bundleExecution
            ? buildBundlePersistenceContext(
                  buildFixedAmountBundleItems({
                      sourceEvents,
                      executionPrice: planning.value.executionPlan.executionPrice,
                      fixedTradeAmountUsdc: ctx.runtime.config.fixedTradeAmountUsdc,
                      plannedCount: bundleExecution.plannedCount,
                      executedCount: bundleExecution.executedCount,
                  })
              )
            : undefined;

        if (bundleExecution && bundleExecution.executedCount <= 0) {
            ctx.state.executionResult = {
                status: 'retry',
                reason: '聚合买单未达到单笔最小金额，稍后重试',
                requestedUsdc: bundleExecution.requestedUsdc,
                requestedSize: planning.value.executionPlan.requestedSize,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: planning.value.executionPlan.executionPrice,
                orderIds: [],
                transactionHashes: [],
                persistenceContext,
            };
            return this.retry(
                ctx.state.executionResult.reason,
                ctx.runtime.config.retryBackoffMs,
                'copytrade.persist'
            );
        }

        ctx.state.tradeExecutionRequest = buildTradeExecutionRequest(ctx, planning.value, {
            requestedUsdc: bundleExecution?.requestedUsdc,
            orderAmount: bundleExecution?.executableUsdc,
            persistenceContext,
        });

        return this.success({
            requestedUsdc: ctx.state.tradeExecutionRequest.requestedUsdc,
            orderAmount: ctx.state.tradeExecutionRequest.orderAmount,
            executionPrice: ctx.state.tradeExecutionRequest.executionPrice,
        });
    }
}
