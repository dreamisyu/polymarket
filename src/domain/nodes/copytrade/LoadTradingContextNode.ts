import type { NodeContext } from '../kernel/NodeContext';
import type { NodeResult } from '../kernel/NodeResult';
import type { CopyTradeWorkflowState } from '../../strategy/workflowState';
import { CopyTradeNode } from './CopyTradeNode';

export class LoadTradingContextNode extends CopyTradeNode {
    constructor() {
        super('copytrade.context');
    }

    async doAction(ctx: NodeContext<CopyTradeWorkflowState>): Promise<NodeResult> {
        const event = ctx.state.sourceEvent;
        if (!event) {
            return this.skip('缺少待执行源事件', null);
        }

        ctx.state.conditionPositions = undefined;
        ctx.state.sizingDecision = undefined;
        ctx.state.marketSnapshot = undefined;
        ctx.state.tradeExecutionRequest = undefined;
        ctx.state.executionResult = undefined;
        ctx.state.policyTrail = [];

        const [portfolio, localPosition, marketSnapshot] = await Promise.all([
            ctx.runtime.gateways.trading.getPortfolioSnapshot(),
            ctx.runtime.gateways.trading.getPositionForEvent(event),
            ctx.runtime.gateways.trading.getMarketSnapshot(event.asset),
        ]);
        ctx.state.portfolio = portfolio;
        ctx.state.localPosition = localPosition;
        ctx.state.marketSnapshot = marketSnapshot;

        return this.success({
            cashBalance: portfolio.cashBalance,
            openPositionCount: portfolio.openPositionCount,
        });
    }
}
