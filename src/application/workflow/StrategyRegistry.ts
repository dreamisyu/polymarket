import type { AppConfig } from '@config/appConfig';
import type { Strategy, StrategyKind } from '@domain';
import FixedAmountCopyTradeStrategy from '@domain/strategy/FixedAmountCopyTradeStrategy';
import ProportionalCopyTradeStrategy from '@domain/strategy/ProportionalCopyTradeStrategy';
import SignalCopyTradeStrategy from '@domain/strategy/SignalCopyTradeStrategy';

export default class StrategyRegistry {
    private readonly strategies: Record<StrategyKind, Strategy>;

    constructor(
        private readonly deps: {
            appConfig: AppConfig;
            fixedAmountCopyTradeStrategy: FixedAmountCopyTradeStrategy;
            proportionalCopyTradeStrategy: ProportionalCopyTradeStrategy;
            signalCopyTradeStrategy: SignalCopyTradeStrategy;
        }
    ) {
        this.strategies = {
            fixed_amount: deps.fixedAmountCopyTradeStrategy,
            proportional: deps.proportionalCopyTradeStrategy,
            signal: deps.signalCopyTradeStrategy,
        };
    }

    get activeStrategy() {
        return this.resolve(this.deps.appConfig.strategyKind);
    }

    resolve(strategyKind: StrategyKind) {
        const strategy = this.strategies[strategyKind];
        if (!strategy) {
            throw new Error(`未注册的策略: ${strategyKind}`);
        }

        return strategy;
    }
}
