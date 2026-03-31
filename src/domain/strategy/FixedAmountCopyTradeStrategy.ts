import { BaseCopyTradeStrategy } from '@domain/strategy/BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from '@domain/strategy/types';

export default class FixedAmountCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'fixed_amount' as const;
    readonly entryNodeId = 'copytrade.fixed_amount.sizing';

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }
}
