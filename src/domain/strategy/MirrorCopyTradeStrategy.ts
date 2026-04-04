import { defaultExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { Strategy } from '@domain/strategy/types';
import { buildStandardCopyTradeWorkflow } from '@domain/strategy/workflowBuilder';

const mirrorCopyTradeStrategy: Strategy = {
    name: 'mirror',
    persistencePlanner: defaultExecutionPersistencePlanner,
    buildWorkflow: () => buildStandardCopyTradeWorkflow(),
    resolveBuyNode: () => 'copytrade.mirror.sizing',
    resolveSellNode: () => 'copytrade.mirror.sizing',
    resolveMergeNode: () => 'copytrade.merge.plan',
    resolveRedeemNode: () => 'copytrade.redeem.forward',
};

export default mirrorCopyTradeStrategy;
