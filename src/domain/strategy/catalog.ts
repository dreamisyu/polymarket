import type { StrategyKind } from '@domain/value-objects/enums';
import FixedAmountCopyTradeStrategy from '@domain/strategy/FixedAmountCopyTradeStrategy';
import MirrorCopyTradeStrategy from '@domain/strategy/MirrorCopyTradeStrategy';
import ProportionalCopyTradeStrategy from '@domain/strategy/ProportionalCopyTradeStrategy';
import SignalCopyTradeStrategy from '@domain/strategy/SignalCopyTradeStrategy';
import type { Strategy } from '@domain/strategy/types';

export const copyTradeStrategies: Record<StrategyKind, Strategy> = {
    fixed_amount: FixedAmountCopyTradeStrategy,
    mirror: MirrorCopyTradeStrategy,
    proportional: ProportionalCopyTradeStrategy,
    signal: SignalCopyTradeStrategy,
};

export const resolveCopyTradeStrategy = (strategyKind: StrategyKind): Strategy => {
    const strategy = copyTradeStrategies[strategyKind];
    if (!strategy) {
        throw new Error(`未注册的策略: ${strategyKind}`);
    }

    return strategy;
};
