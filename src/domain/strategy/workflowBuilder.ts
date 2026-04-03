import { NodeChainBuilder, type NodeWorkflowDefinition } from '@domain/nodes/kernel/NodeChainBuilder';
import {
    applyStrategyExtensions,
    type StrategyExtensionDefinition,
} from '@domain/strategy/types';

export const buildStandardCopyTradeWorkflow = (options: {
    tradeEntryNodeId: string;
    tradePlanningNodeId?: string;
    extensions?: StrategyExtensionDefinition[];
}): NodeWorkflowDefinition => {
    const tradePlanningNodeId = options.tradePlanningNodeId || 'copytrade.trade.plan';
    const builder = new NodeChainBuilder()
        .append('copytrade.context')
        .append('copytrade.action-router')
        .append(options.tradeEntryNodeId)
        .append('copytrade.risk')
        .append(tradePlanningNodeId)
        .append('copytrade.trade.execute')
        .append('copytrade.merge.plan')
        .append('copytrade.merge.execute')
        .append('copytrade.redeem.forward')
        .append('copytrade.persist');

    builder.setTransition('copytrade.action-router', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'success', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'skip', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'retry', 'copytrade.persist');
    builder.setTransition('copytrade.trade.execute', 'fail', 'copytrade.persist');
    builder.setTransition(tradePlanningNodeId, 'success', 'copytrade.trade.execute');
    builder.setTransition(tradePlanningNodeId, 'skip', 'copytrade.persist');
    builder.setTransition(tradePlanningNodeId, 'retry', 'copytrade.persist');
    builder.setTransition(tradePlanningNodeId, 'fail', 'copytrade.persist');
    builder.setTransition('copytrade.risk', 'skip', 'copytrade.persist');
    builder.setTransition(options.tradeEntryNodeId, 'skip', 'copytrade.persist');
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
    applyStrategyExtensions(builder, options.extensions || []);

    return builder.build();
};
