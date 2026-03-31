import { BaseCopyTradeStrategy } from '@domain/strategy/BaseCopyTradeStrategy';
import type { StrategyExtensionDefinition } from '@domain/strategy/types';

export default class SignalCopyTradeStrategy extends BaseCopyTradeStrategy {
    readonly name = 'signal' as const;
    readonly entryNodeId = 'copytrade.signal.sizing';

    constructor(extensions: StrategyExtensionDefinition[] = []) {
        super(extensions);
    }
}
