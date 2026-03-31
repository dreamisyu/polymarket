import { BaseCopyTradeStrategy } from '@domain/strategy/BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from '@domain/strategy/types';

export default class ProportionalCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'proportional' as const;
    readonly entryNodeId = 'copytrade.proportional.sizing';

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }
}
