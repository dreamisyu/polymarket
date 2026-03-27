import type { RuntimeConfig } from '../../config/runtimeConfig';
import type { SourceActivityRecord, UserPositionRecord } from '../../types/polymarket';
import { fetchJson } from '../http/fetchJson';

export interface OrderBookRecord {
    market?: string;
    asset_id?: string;
    timestamp?: string | number;
    bids?: Array<{ price: string; size: string }>;
    asks?: Array<{ price: string; size: string }>;
    min_order_size?: string;
    tick_size?: string;
    neg_risk?: boolean;
    last_trade_price?: string;
}

export const fetchSourceActivities = async (
    params: { start: number; end: number; limit: number },
    config: Pick<RuntimeConfig, 'dataApiUrl' | 'sourceWallet'>
) => {
    const search = new URLSearchParams({
        user: config.sourceWallet,
        start: String(params.start),
        end: String(params.end),
        limit: String(params.limit),
        sortDirection: 'ASC',
    });
    return fetchJson<SourceActivityRecord[]>(`${config.dataApiUrl.replace(/\/+$/, '')}/activity?${search.toString()}`);
};

export const fetchUserPositions = async (
    wallet: string,
    config: Pick<RuntimeConfig, 'dataApiUrl'>
) => fetchJson<UserPositionRecord[]>(`${config.dataApiUrl.replace(/\/+$/, '')}/positions?user=${encodeURIComponent(wallet)}&sizeThreshold=0`);
