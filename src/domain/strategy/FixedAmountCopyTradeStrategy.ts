import { NodeChainBuilder } from '@domain/nodes/kernel/NodeChainBuilder';
import { defaultExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { Strategy } from '@domain/strategy/types';

const buildFixedAmountWorkflow = () => {
    const builder = new NodeChainBuilder()
        .append('copytrade.context')
        .append('copytrade.action-router')
        .append('copytrade.fixed_amount.sizing')
        .append('copytrade.risk')
        .append('copytrade.fixed_amount.trade.plan')
        .append('copytrade.trade.execute')
        .append('copytrade.merge.plan')
        .append('copytrade.merge.execute')
        .append('copytrade.redeem.forward')
        .append('copytrade.persist');

    builder.setTransition('copytrade.action-router', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.fixed_amount.sizing', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.risk', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.fixed_amount.trade.plan', 'success', 'copytrade.trade.execute');
    builder.setTransition('copytrade.fixed_amount.trade.plan', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.fixed_amount.trade.plan', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.fixed_amount.trade.plan', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'success', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.merge.plan', 'success', 'copytrade.merge.execute');
    builder.setTransition('copytrade.merge.plan', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.merge.plan', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.merge.plan', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.merge.execute', 'success', 'copytrade.persist');
    builder.setTransition('copytrade.merge.execute', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.merge.execute', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.merge.execute', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.redeem.forward', 'success', 'copytrade.persist');
    builder.setTransition('copytrade.redeem.forward', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.redeem.forward', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.redeem.forward', 'fail', 'copytrade.persist');

    return builder.build();
};

const fixedAmountCopyTradeStrategy: Strategy = {
    name: 'fixed_amount',
    persistencePlanner: defaultExecutionPersistencePlanner,
    buildWorkflow: buildFixedAmountWorkflow,
    resolveBuyNode: () => 'copytrade.fixed_amount.sizing',
    resolveSellNode: () => 'copytrade.fixed_amount.sizing',
    resolveMergeNode: () => 'copytrade.merge.plan',
    resolveRedeemNode: () => 'copytrade.redeem.forward',
};

export default fixedAmountCopyTradeStrategy;
