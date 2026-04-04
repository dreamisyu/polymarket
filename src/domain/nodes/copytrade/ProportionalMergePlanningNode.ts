import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';

export class ProportionalMergePlanningNode extends CopyTradeNode {
    constructor() {
        super('copytrade.proportional.merge.plan');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        if (!event) {
            return this.skip('缺少 MERGE 源事件', 'copytrade.persist');
        }

        const sourceMergeRequestedSize = Math.max(
            Number(event.size) || 0,
            Number(event.usdcSize) || 0,
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
}
