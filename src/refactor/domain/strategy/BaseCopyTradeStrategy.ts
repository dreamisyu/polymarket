import { NodeChainBuilder } from '../nodes/kernel/NodeChainBuilder';
import type { NodeRegistry } from '../nodes/kernel/NodeRegistry';
import { ActionRouterNode } from '../nodes/copytrade/ActionRouterNode';
import { ExecuteTradeNode } from '../nodes/copytrade/ExecuteTradeNode';
import { LoadTradingContextNode } from '../nodes/copytrade/LoadTradingContextNode';
import { MergeExecuteNode } from '../nodes/copytrade/MergeExecuteNode';
import { MergePlanningNode } from '../nodes/copytrade/MergePlanningNode';
import { PersistExecutionNode } from '../nodes/copytrade/PersistExecutionNode';
import { RedeemForwardNode } from '../nodes/copytrade/RedeemForwardNode';
import { RiskGuardNode } from '../nodes/copytrade/RiskGuardNode';
import type { Strategy, StrategyBuildResult, StrategyExtensionDefinition } from './types';
import { applyStrategyExtensions } from './types';

export abstract class BaseCopyTradeStrategy implements Strategy {
    abstract readonly name: StrategyBuildResult['strategyKind'];
    private readonly extensions: StrategyExtensionDefinition[];

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        this.extensions = extensions;
    }

    protected registerCommonNodes(registry: NodeRegistry, strategyEntryNodeId: string) {
        registry.register(new ActionRouterNode(strategyEntryNodeId));
        registry.register(new LoadTradingContextNode());
        registry.register(new RiskGuardNode());
        registry.register(new ExecuteTradeNode());
        registry.register(new MergePlanningNode());
        registry.register(new MergeExecuteNode());
        registry.register(new RedeemForwardNode());
        registry.register(new PersistExecutionNode());
    }

    protected abstract registerStrategyNodes(registry: NodeRegistry): string;

    build(registry: NodeRegistry): StrategyBuildResult {
        const sizingNodeId = this.registerStrategyNodes(registry);
        this.registerCommonNodes(registry, sizingNodeId);
        const builder = new NodeChainBuilder()
            .append('copytrade.context')
            .append('copytrade.action-router')
            .append(sizingNodeId)
            .append('copytrade.risk')
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
            workflow,
        };
    }
}
