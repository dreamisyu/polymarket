import type { RuntimeConfig } from '../config/runtimeConfig';
import type { GammaMarketRecord, MarketTokenRecord } from '../infrastructure/polymarket/dto';
import { fetchJson } from '../infrastructure/http/fetchJson';
import { toSafeNumber } from './math';

interface ClobMarketRecord {
    condition_id?: string;
    conditionId?: string;
    market_slug?: string;
    marketSlug?: string;
    question?: string;
    closed?: boolean;
    accepting_orders?: boolean;
    acceptingOrders?: boolean;
    active?: boolean;
    archived?: boolean;
    tokens?: MarketTokenRecord[];
}

export interface MarketResolution {
    conditionId: string;
    marketSlug: string;
    marketUrl: string;
    resolvedStatus: string;
    winnerOutcome: string;
    title: string;
    updateDescription: string;
    source: 'clob' | 'gamma';
    closed: boolean;
    acceptingOrders: boolean | null;
    active: boolean | null;
    archived: boolean | null;
}

const resolutionCache = new Map<string, { checkedAt: number; resolution: MarketResolution | null }>();
const resolvedTtlMs = 10 * 60_000;
const unresolvedTtlMs = 30_000;

const parseArrayLike = (value: unknown) => {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }

    const normalized = String(value || '').trim();
    if (!normalized) {
        return [] as string[];
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item || '').trim()).filter(Boolean);
        }
    } catch {
        return normalized.split(',').map((item) => String(item || '').trim()).filter(Boolean);
    }

    return [] as string[];
};

export const normalizeOutcomeLabel = (value: string) =>
    String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const buildMarketUrl = (marketSlug: string) =>
    marketSlug ? `https://polymarket.com/event/${marketSlug}/${marketSlug}` : '';

const inferWinnerFromTokens = (tokens: MarketTokenRecord[] = []) =>
    normalizeOutcomeLabel(tokens.find((token) => token.winner)?.outcome || '');

const inferWinnerFromOutcomePrices = (outcomes: string | string[] | null | undefined, prices: string | string[] | null | undefined) => {
    const normalizedOutcomes = parseArrayLike(outcomes);
    const normalizedPrices = parseArrayLike(prices).map((value) => toSafeNumber(value, -1));
    if (normalizedOutcomes.length === 0 || normalizedOutcomes.length !== normalizedPrices.length) {
        return '';
    }

    const winnerIndex = normalizedPrices.findIndex((value) => value >= 0.999);
    if (winnerIndex < 0) {
        return '';
    }

    return normalizeOutcomeLabel(normalizedOutcomes[winnerIndex]);
};

const deriveResolvedStatus = (params: {
    winnerOutcome: string;
    closed: boolean;
    acceptingOrders: boolean | null;
    umaResolutionStatus?: string | null;
}) => {
    const normalizedUma = String(params.umaResolutionStatus || '').trim().toLowerCase();
    if (params.winnerOutcome) {
        return 'resolved';
    }

    if (normalizedUma.includes('resolved') || normalizedUma.includes('finalized') || normalizedUma.includes('settled')) {
        return 'resolved';
    }

    if (params.closed || params.acceptingOrders === false) {
        return 'closed';
    }

    return 'open';
};

const fetchClobMarketResolution = async (conditionId: string, config: Pick<RuntimeConfig, 'clobHttpUrl'>) => {
    const response = await fetchJson<ClobMarketRecord>(`${config.clobHttpUrl.replace(/\/+$/, '')}/markets/${conditionId}`);
    if (!response) {
        return null;
    }

    const winnerOutcome = inferWinnerFromTokens(response.tokens || []);
    const marketSlug = String(response.market_slug || response.marketSlug || '').trim();
    const acceptingOrders =
        typeof response.accepting_orders === 'boolean'
            ? response.accepting_orders
            : typeof response.acceptingOrders === 'boolean'
              ? response.acceptingOrders
              : null;

    return {
        conditionId: String(response.condition_id || response.conditionId || conditionId).trim(),
        marketSlug,
        marketUrl: buildMarketUrl(marketSlug),
        resolvedStatus: deriveResolvedStatus({
            winnerOutcome,
            closed: Boolean(response.closed),
            acceptingOrders,
        }),
        winnerOutcome,
        title: String(response.question || '').trim(),
        updateDescription: winnerOutcome || Boolean(response.closed) ? `source=clob closed=${Boolean(response.closed)}` : 'source=clob unresolved',
        source: 'clob' as const,
        closed: Boolean(response.closed),
        acceptingOrders,
        active: typeof response.active === 'boolean' ? response.active : null,
        archived: typeof response.archived === 'boolean' ? response.archived : null,
    };
};

const fetchGammaMarketBySlug = async (marketSlug: string, config: Pick<RuntimeConfig, 'gammaApiUrl'>) => {
    const bySlug = await fetchJson<GammaMarketRecord | GammaMarketRecord[]>(`${config.gammaApiUrl.replace(/\/+$/, '')}/markets/slug/${marketSlug}`);
    if (Array.isArray(bySlug)) {
        return bySlug[0] || null;
    }
    if (bySlug && typeof bySlug === 'object') {
        return bySlug;
    }

    const list = await fetchJson<GammaMarketRecord[]>(`${config.gammaApiUrl.replace(/\/+$/, '')}/markets?slug=${encodeURIComponent(marketSlug)}`);
    return Array.isArray(list) ? list[0] || null : null;
};

const fetchGammaMarketResolution = async (params: { conditionId?: string; marketSlug?: string; title?: string }, config: Pick<RuntimeConfig, 'gammaApiUrl'>) => {
    const marketSlug = String(params.marketSlug || '').trim();
    if (!marketSlug) {
        return null;
    }

    const response = await fetchGammaMarketBySlug(marketSlug, config);
    if (!response) {
        return null;
    }

    const winnerOutcome = inferWinnerFromTokens(response.tokens || []) || inferWinnerFromOutcomePrices(response.outcomes, response.outcomePrices);
    const acceptingOrders = typeof response.acceptingOrders === 'boolean' ? response.acceptingOrders : null;

    return {
        conditionId: String(response.conditionId || params.conditionId || '').trim(),
        marketSlug: String(response.slug || marketSlug).trim(),
        marketUrl: buildMarketUrl(String(response.slug || marketSlug).trim()),
        resolvedStatus: deriveResolvedStatus({
            winnerOutcome,
            closed: Boolean(response.closed),
            acceptingOrders,
            umaResolutionStatus: response.umaResolutionStatus,
        }),
        winnerOutcome,
        title: String(response.question || params.title || '').trim(),
        updateDescription: `source=gamma uma=${String(response.umaResolutionStatus || 'unknown').trim()}`,
        source: 'gamma' as const,
        closed: Boolean(response.closed),
        acceptingOrders,
        active: typeof response.active === 'boolean' ? response.active : null,
        archived: typeof response.archived === 'boolean' ? response.archived : null,
    };
};

export const fetchMarketResolution = async (
    params: { conditionId?: string; marketSlug?: string; title?: string },
    config: Pick<RuntimeConfig, 'clobHttpUrl' | 'gammaApiUrl'>
) => {
    const cacheKey = String(params.conditionId || '').trim() || `slug:${String(params.marketSlug || '').trim()}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached) {
        const ttl = cached.resolution?.resolvedStatus === 'resolved' ? resolvedTtlMs : unresolvedTtlMs;
        if (Date.now() - cached.checkedAt < ttl) {
            return cached.resolution;
        }
    }

    const clobResolution = params.conditionId ? await fetchClobMarketResolution(params.conditionId, config) : null;
    const resolution =
        clobResolution && clobResolution.resolvedStatus === 'resolved'
            ? clobResolution
            : (await fetchGammaMarketResolution(params, config)) || clobResolution;
    resolutionCache.set(cacheKey, { checkedAt: Date.now(), resolution });
    return resolution;
};

export const isResolvedMarket = (resolution: MarketResolution | null | undefined) =>
    String(resolution?.resolvedStatus || '').trim().toLowerCase() === 'resolved';
