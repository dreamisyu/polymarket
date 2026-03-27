import type { StrategyKind } from '..';
import { FixedAmountCopyTradeStrategy } from './FixedAmountCopyTradeStrategy';
import { ProportionalCopyTradeStrategy } from './ProportionalCopyTradeStrategy';
import { SignalCopyTradeStrategy } from './SignalCopyTradeStrategy';
import type { Strategy, StrategyExtensionDefinition } from './types';

export const createStrategy = (
    strategyKind: StrategyKind,
    extensions: StrategyExtensionDefinition[] = []
): Strategy => {
    if (strategyKind === 'signal') {
        return new SignalCopyTradeStrategy(extensions);
    }

    if (strategyKind === 'fixed_amount') {
        return new FixedAmountCopyTradeStrategy(extensions);
    }

    return new ProportionalCopyTradeStrategy(extensions);
};
