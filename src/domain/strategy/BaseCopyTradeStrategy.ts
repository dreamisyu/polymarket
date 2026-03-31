import { NodeChainBuilder } from '@domain/nodes/kernel/NodeChainBuilder';
import type {
    Strategy,
    StrategyBuildResult,
    StrategyExtensionDefinition,
} from '@domain/strategy/types';
import { applyStrategyExtensions } from '@domain/strategy/types';

export abstract class BaseCopyTradeStrategy implements Strategy {
    abstract readonly name: StrategyBuildResult['strategyKind'];
    abstract readonly entryNodeId: string;
    private readonly extensions: StrategyExtensionDefinition[];

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        this.extensions = extensions;
    }

    build(): StrategyBuildResult {
        const sizingNodeId = this.entryNodeId;
        const builder = new NodeChainBuilder()
            .append('copytrade.context')
            .append('copytrade.action-router')
            .append(sizingNodeId)
            .append('copytrade.risk')
            .append('copytrade.trade.plan')
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
        builder.setTransition('copytrade.trade.plan', 'success', 'copytrade.trade.execute');
        builder.setTransition('copytrade.trade.plan', 'skip', 'copytrade.persist');
        builder.setTransition('copytrade.trade.plan', 'retry', 'copytrade.persist');
        builder.setTransition('copytrade.trade.plan', 'fail', 'copytrade.persist');
        builder.setTransition('copytrade.risk', 'skip', 'copytrade.persist');
        builder.setTransition(sizingNodeId, 'skip', 'copytrade.persist');
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
        applyStrategyExtensions(builder, this.extensions);
        const workflow = builder.build();

        return {
            strategyKind: this.name,
            headNodeId: workflow.headNodeId,
            entryNodeId: this.entryNodeId,
            workflow,
        };
    }
}
