import type { NodeRegistry } from '../kernel/NodeRegistry';
import { FixedAmountSizingNode } from '../nodes/copytrade/SizingNodes';
import { BaseCopyTradeStrategy } from './BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from './types';

export class FixedAmountCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'fixed_amount' as const;

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }

    protected registerStrategyNodes(registry: NodeRegistry) {
        registry.register(new FixedAmountSizingNode());
        return 'copytrade.fixed_amount.sizing';
    }
}
