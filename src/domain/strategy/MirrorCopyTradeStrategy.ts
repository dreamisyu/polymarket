import { defaultExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { Strategy } from '@domain/strategy/types';
import { buildStandardCopyTradeWorkflow } from '@domain/strategy/workflowBuilder';

const tradeEntryNodeId = 'copytrade.mirror.sizing';

const mirrorCopyTradeStrategy: Strategy = {
    name: 'mirror',
    persistencePlanner: defaultExecutionPersistencePlanner,
    buildWorkflow: () => buildStandardCopyTradeWorkflow({ tradeEntryNodeId }),
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

export default mirrorCopyTradeStrategy;
