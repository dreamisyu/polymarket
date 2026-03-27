import type { NodeRegistry } from '../nodes/kernel/NodeRegistry';
import { SignalSizingNode } from '../nodes/copytrade/SizingNodes';
import { BaseCopyTradeStrategy } from './BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from './types';

export class SignalCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'signal' as const;

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }

    protected registerStrategyNodes(registry: NodeRegistry) {
        registry.register(new SignalSizingNode());
        return 'copytrade.signal.sizing';
    }
}
