import type { RuntimeConfig } from '../config/runtimeConfig';
import type { SourceTradeEvent } from '../domain';
import { isTradeWithinMarketWhitelist } from './marketScope';

export type SourceEventBuyFilterCode = 'market_whitelist' | 'min_source_buy_usdc';

export interface SourceEventBuyFilterRejection {
    code: SourceEventBuyFilterCode;
    reason: string;
}

export const resolveSourceEventBuyFilterRejection = (
    event: Pick<SourceTradeEvent, 'action' | 'title' | 'slug' | 'eventSlug' | 'usdcSize'>,
    config: Pick<RuntimeConfig, 'marketWhitelist' | 'minSourceBuyUsdc'>
): SourceEventBuyFilterRejection | null => {
    if (event.action !== 'buy') {
        return null;
    }

    if (!isTradeWithinMarketWhitelist(event, config.marketWhitelist)) {
        return {
            code: 'market_whitelist',
            reason: '市场不在白名单内，已跳过买入信号',
        };
    }

    const minSourceBuyUsdc = Math.max(Number(config.minSourceBuyUsdc) || 0, 0);
    const sourceUsdc = Math.max(Number(event.usdcSize) || 0, 0);
    if (minSourceBuyUsdc > 0 && sourceUsdc < minSourceBuyUsdc) {
        return {
            code: 'min_source_buy_usdc',
            reason: `源买入金额低于最小阈值 ${minSourceBuyUsdc} USDC，已跳过`,
        };
    }

    return null;
};
