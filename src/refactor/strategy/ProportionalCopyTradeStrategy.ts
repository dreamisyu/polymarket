import type { NodeRegistry } from '../kernel/NodeRegistry';
import { ProportionalSizingNode } from '../nodes/copytrade/SizingNodes';
import { BaseCopyTradeStrategy } from './BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from './types';

export class ProportionalCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'proportional' as const;

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }

    protected registerStrategyNodes(registry: NodeRegistry) {
        registry.register(new ProportionalSizingNode());
        return 'copytrade.proportional.sizing';
    }
}
