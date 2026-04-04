import { NodeChainBuilder } from '@domain/nodes/kernel/NodeChainBuilder';
import { defaultExecutionPersistencePlanner } from '@domain/strategy/executionPersistence';
import type { Strategy } from '@domain/strategy/types';

const buildProportionalWorkflow = () => {
    const builder = new NodeChainBuilder()
        .append('copytrade.context')
        .append('copytrade.action-router')
        .append('copytrade.proportional.sizing')
        .append('copytrade.risk')
        .append('copytrade.trade.plan')
        .append('copytrade.trade.execute')
        .append('copytrade.proportional.merge.plan')
        .append('copytrade.merge.execute')
        .append('copytrade.redeem.forward')
        .append('copytrade.persist');

    builder.setTransition('copytrade.action-router', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.proportional.sizing', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.risk', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.plan', 'success', 'copytrade.trade.execute');
    builder.setTransition('copytrade.trade.plan', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.plan', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.trade.plan', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'success', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.proportional.merge.plan', 'success', 'copytrade.merge.execute');
    builder.setTransition('copytrade.proportional.merge.plan', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.proportional.merge.plan', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.proportional.merge.plan', 'fail', 'copytrade.persist');
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

const proportionalCopyTradeStrategy: Strategy = {
    name: 'proportional',
    persistencePlanner: defaultExecutionPersistencePlanner,
    buildWorkflow: buildProportionalWorkflow,
    resolveBuyNode: () => 'copytrade.proportional.sizing',
    resolveSellNode: () => 'copytrade.proportional.sizing',
    resolveMergeNode: () => 'copytrade.proportional.merge.plan',
    resolveRedeemNode: () => 'copytrade.redeem.forward',
};

export default proportionalCopyTradeStrategy;
