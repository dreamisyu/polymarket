import type { NodeContext } from '@domain/nodes/kernel/NodeContext';
import type { NodeResult } from '@domain/nodes/kernel/NodeResult';
import type { CopyTradeWorkflowState } from '@domain/strategy/workflowState';
import { CopyTradeNode } from '@domain/nodes/copytrade/CopyTradeNode';
import { isMarketWindowClosed } from '@domain/market/marketWindow';
import { resolveSourceEventBuyFilterRejection } from '@domain/strategy/sourceEventFilters';

export class RiskGuardNode extends CopyTradeNode {
    constructor() {
        super('copytrade.risk');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        const portfolio = ctx.state.portfolio;
        const localPosition = ctx.state.localPosition;
        if (!event || !portfolio) {
            return this.skip('缺少风控所需上下文', 'copytrade.persist');
        }

        if (event.action !== 'buy') {
            return this.success();
        }

        const buildSkipExecutionResult = (reason: string) => ({
            status: 'skipped' as const,
            reason,
            requestedUsdc: 0,
            requestedSize: 0,
            executedUsdc: 0,
            executedSize: 0,
            executionPrice: 0,
            orderIds: [],
            transactionHashes: [],
        });

        const sourceFilterRejection = resolveSourceEventBuyFilterRejection(
            event,
            ctx.runtime.config
        );
        if (sourceFilterRejection) {
            ctx.state.executionResult = buildSkipExecutionResult(sourceFilterRejection.reason);
            ctx.state.policyTrail = [
                ...(ctx.state.policyTrail || []),
                `risk:${sourceFilterRejection.code}`,
            ];
            return this.skip(sourceFilterRejection.reason, 'copytrade.persist');
        }

        const signalAgeMs = Math.max(ctx.now() - Math.max(Number(event.timestamp) || 0, 0), 0);
        const maxSignalAgeMs = Math.max(Number(ctx.runtime.config.maxSignalAgeMs) || 15_000, 0);
        if (maxSignalAgeMs > 0 && signalAgeMs > maxSignalAgeMs) {
            ctx.state.executionResult = buildSkipExecutionResult(
                `信号已超过最大时效 ${maxSignalAgeMs}ms，已跳过迟到买单`
            );
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:signal_stale'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (isMarketWindowClosed(event, ctx.now())) {
            ctx.state.executionResult =
                buildSkipExecutionResult('市场交易窗口已结束，已跳过迟到买单');
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:market_window_closed'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (!localPosition && portfolio.openPositionCount >= ctx.runtime.config.maxOpenPositions) {
            ctx.state.executionResult = buildSkipExecutionResult(
                `已达到最大持仓数 ${ctx.runtime.config.maxOpenPositions}`
            );
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:max_open_positions'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (portfolio.activeExposureUsdc >= ctx.runtime.config.maxActiveExposureUsdc) {
            ctx.state.executionResult = buildSkipExecutionResult(
                `已达到最大活跃敞口 ${ctx.runtime.config.maxActiveExposureUsdc} USDC`
            );
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:max_active_exposure'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        return this.success();
    }
}
