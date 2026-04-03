import type { AppConfig } from '@config/appConfig';
import type { StrategyKind } from '@domain';
import { resolveCopyTradeStrategy } from '@domain/strategy/catalog';

export default class StrategyRegistry {
    constructor(private readonly deps: { appConfig: AppConfig }) {}

    get activeStrategy() {
        return this.resolve(this.deps.appConfig.strategyKind);
    }

    resolve(strategyKind: StrategyKind) {
        return resolveCopyTradeStrategy(strategyKind);
    }
}
