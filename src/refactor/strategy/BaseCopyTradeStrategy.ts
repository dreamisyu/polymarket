import { NodeChainBuilder } from '../kernel/NodeChainBuilder';
import type { NodeRegistry } from '../kernel/NodeRegistry';
import { ClaimSourceEventNode } from '../nodes/copytrade/ClaimSourceEventNode';
import { ExecuteTradeNode } from '../nodes/copytrade/ExecuteTradeNode';
import { LoadTradingContextNode } from '../nodes/copytrade/LoadTradingContextNode';
import { PersistExecutionNode } from '../nodes/copytrade/PersistExecutionNode';
import { RiskGuardNode } from '../nodes/copytrade/RiskGuardNode';
import type { Strategy, StrategyBuildResult, StrategyExtensionDefinition } from './types';
import { applyStrategyExtensions } from './types';

export abstract class BaseCopyTradeStrategy implements Strategy {
    abstract readonly name: StrategyBuildResult['strategyKind'];
    private readonly extensions: StrategyExtensionDefinition[];

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        this.extensions = extensions;
    }

    protected registerCommonNodes(registry: NodeRegistry) {
        registry.register(new ClaimSourceEventNode());
        registry.register(new LoadTradingContextNode());
        registry.register(new RiskGuardNode());
        registry.register(new ExecuteTradeNode());
        registry.register(new PersistExecutionNode());
    }

    protected abstract registerStrategyNodes(registry: NodeRegistry): string;

    build(registry: NodeRegistry): StrategyBuildResult {
        this.registerCommonNodes(registry);
        const sizingNodeId = this.registerStrategyNodes(registry);
        const builder = new NodeChainBuilder()
            .append('copytrade.claim')
            .append('copytrade.context')
            .append(sizingNodeId)
            .append('copytrade.risk')
            .append('copytrade.execute')
            .append('copytrade.persist');
        builder.setTransition('copytrade.execute', 'success', 'copytrade.persist');
        builder.setTransition('copytrade.execute', 'skip', 'copytrade.persist');
        builder.setTransition('copytrade.execute', 'retry', 'copytrade.persist');
        builder.setTransition('copytrade.execute', 'fail', 'copytrade.persist');
        builder.setTransition('copytrade.risk', 'skip', 'copytrade.persist');
        builder.setTransition(sizingNodeId, 'skip', 'copytrade.persist');
        applyStrategyExtensions(builder, this.extensions);
        const workflow = builder.build();

        return {
            strategyKind: this.name,
            headNodeId: workflow.headNodeId,
            workflow,
        };
    }
}
