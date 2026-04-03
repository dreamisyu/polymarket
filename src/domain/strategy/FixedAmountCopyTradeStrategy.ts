import { defaultExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { Strategy } from '@domain/strategy/types';
import { buildStandardCopyTradeWorkflow } from '@domain/strategy/workflowBuilder';

const tradeEntryNodeId = 'copytrade.fixed_amount.sizing';

const fixedAmountCopyTradeStrategy: Strategy = {
    name: 'fixed_amount',
    persistencePlanner: defaultExecutionPersistencePlanner,
    buildWorkflow: () =>
        buildStandardCopyTradeWorkflow({
            tradeEntryNodeId,
            tradePlanningNodeId: 'copytrade.fixed_amount.trade.plan',
        }),
    resolveActionNode(action) {
        if (action === 'buy' || action === 'sell') {
            return tradeEntryNodeId;
        }
        if (action === 'merge') {
            return 'copytrade.merge.plan';
        }
        if (action === 'redeem') {
            return 'copytrade.redeem.forward';
        }

        return null;
    },
};

export default fixedAmountCopyTradeStrategy;
