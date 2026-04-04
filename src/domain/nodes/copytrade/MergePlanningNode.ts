import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';

export class MergePlanningNode extends CopyTradeNode {
    constructor() {
        super('copytrade.merge.plan');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const strategyKind = ctx.strategyKind || ctx.runtime.config.strategyKind;
        if (!event) {
            return this.skip('缺少 MERGE 源事件', 'copytrade.persist');
        }

        const sourceMergeRequestedSize = Math.max(
            Number(event.size) || 0,
            Number(event.usdcSize) || 0,
            0
        );
        const sourceMergeableBefore = Math.max(
            Number(event.sourceConditionMergeableSizeBeforeTrade) || 0,
            (Number(event.sourceConditionMergeableSizeAfterTrade) || 0) + sourceMergeRequestedSize,
            0
        );
        const conditionPositions = await ctx.runtime.gateways.trading.listConditionPositions(
            event.conditionId
        );
        ctx.state.conditionPositions = conditionPositions;

        if (sourceMergeRequestedSize <= 0) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '源 MERGE 数量无效，已跳过 merge',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (strategyKind !== 'proportional' && sourceMergeableBefore <= 0) {
            ctx.state.executionResult = {
                status: 'retry',
                reason: '缺少源账户 condition mergeable 快照，暂缓 merge',
                requestedUsdc: 0,
                requestedSize: 0,
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

        if (conditionPositions.positions.length < 2 || conditionPositions.mergeableSize <= 0) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '本地无可 merge 的 complete set',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (strategyKind === 'proportional') {
            const requestedSize = Math.min(
                sourceMergeRequestedSize * ctx.runtime.config.proportionalCopyRatio,
                conditionPositions.mergeableSize
            );
            if (requestedSize <= 0) {
                ctx.state.executionResult = {
                    status: 'skipped',
                    reason: '按比例缩放后的本地 merge 数量为 0',
                    requestedUsdc: 0,
                    requestedSize: 0,
                    executedUsdc: 0,
                    executedSize: 0,
                    executionPrice: 0,
                    orderIds: [],
                    transactionHashes: [],
                };
                return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
            }

            ctx.state.sizingDecision = {
                status: 'ready',
                requestedSize,
                reason: `根据比例跟单 ${(ctx.runtime.config.proportionalCopyRatio * 100).toFixed(2)}% 执行本地 merge`,
                note: `比例跟单 ${(ctx.runtime.config.proportionalCopyRatio * 100).toFixed(2)}%`,
            };
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'merge:proportional'];
            return this.success({
                requestedSize,
                proportionalCopyRatio: ctx.runtime.config.proportionalCopyRatio,
            });
        }

        const sourceMergeRatio = Math.min(sourceMergeRequestedSize / sourceMergeableBefore, 1);
        const requestedSize = Math.max(conditionPositions.mergeableSize * sourceMergeRatio, 0);
        if (requestedSize <= 0) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '按比例换算后的本地 merge 数量为 0',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        ctx.state.sizingDecision = {
            status: 'ready',
            requestedSize,
            reason: `根据源账户 MERGE 比例 ${(sourceMergeRatio * 100).toFixed(2)}% 执行本地 merge`,
        };
        ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'merge:mirror'];
        return this.success({ requestedSize, sourceMergeRatio });
    }
}
