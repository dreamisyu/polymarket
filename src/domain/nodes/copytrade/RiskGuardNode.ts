import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';
import { isMarketWindowClosed } from '../../../utils/marketWindow';

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

        if (isMarketWindowClosed(event, ctx.now())) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: '市场交易窗口已结束，已跳过迟到买单',
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:market_window_closed'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (
            !localPosition &&
            portfolio.openPositionCount >= ctx.runtime.config.maxOpenPositions
        ) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: `已达到最大持仓数 ${ctx.runtime.config.maxOpenPositions}`,
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:max_open_positions'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        if (portfolio.activeExposureUsdc >= ctx.runtime.config.maxActiveExposureUsdc) {
            ctx.state.executionResult = {
                status: 'skipped',
                reason: `已达到最大活跃敞口 ${ctx.runtime.config.maxActiveExposureUsdc} USDC`,
                requestedUsdc: 0,
                requestedSize: 0,
                executedUsdc: 0,
                executedSize: 0,
                executionPrice: 0,
                orderIds: [],
                transactionHashes: [],
            };
            ctx.state.policyTrail = [...(ctx.state.policyTrail || []), 'risk:max_active_exposure'];
            return this.skip(ctx.state.executionResult.reason, 'copytrade.persist');
        }

        return this.success();
    }
}
