import { ENV } from '../config/env';
import fetchData from './fetchData';

const NEW_YORK_TIME_ZONE = 'America/New_York';
const GAMMA_API_BASE_URL = 'https://gamma-api.polymarket.com';
const RESOLUTION_CACHE_RESOLVED_TTL_MS = 10 * 60_000;
const RESOLUTION_CACHE_UNRESOLVED_TTL_MS = 30_000;
const TITLE_RE =
    /^Bitcoin Up or Down - ([A-Za-z]+) (\d+), (\d{1,2}:\d{2}[AP]M)-(\d{1,2}:\d{2}[AP]M) ET$/;
const MONTH_INDEX: Record<string, number> = {
    January: 0,
    February: 1,
    March: 2,
    April: 3,
    May: 4,
    June: 5,
    July: 6,
    August: 7,
    September: 8,
    October: 9,
    November: 10,
    December: 11,
};

interface PolymarketMarketToken {
    outcome?: string;
    winner?: boolean;
    price?: number | string;
}

interface ClobMarketResponse {
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
    tokens?: PolymarketMarketToken[];
}

interface GammaMarketResponse {
    conditionId?: string;
    slug?: string;
    question?: string;
    closed?: boolean;
    acceptingOrders?: boolean;
    active?: boolean;
    archived?: boolean;
    umaResolutionStatus?: string | null;
    outcomes?: string | string[] | null;
    outcomePrices?: string | string[] | null;
    tokens?: PolymarketMarketToken[];
}

export interface PolymarketMarketResolution {
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

const resolutionCache = new Map<
    string,
    {
        checkedAt: number;
        resolution: PolymarketMarketResolution | null;
    }
>();

export interface FetchPolymarketMarketResolutionParams {
    conditionId?: string;
    marketSlug?: string;
    title?: string;
}

const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseArrayLike = (value: unknown): string[] => {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }

    const normalized = String(value || '').trim();
    if (!normalized) {
        return [];
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item || '').trim()).filter(Boolean);
        }
    } catch {
        return normalized
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    return [];
};

const buildMarketUrl = (marketSlug: string) =>
    marketSlug ? `https://polymarket.com/event/${marketSlug}/${marketSlug}` : '';
const mergeResolutionDescriptions = (...values: string[]) =>
    [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].join('；');

const inferWinnerFromTokens = (tokens: PolymarketMarketToken[] = []) =>
    normalizeOutcomeLabel(tokens.find((token) => token.winner)?.outcome || '');

const inferWinnerFromOutcomePrices = (
    outcomes: string | string[] | null | undefined,
    outcomePrices: string | string[] | null | undefined
) => {
    const normalizedOutcomes = parseArrayLike(outcomes);
    const normalizedPrices = parseArrayLike(outcomePrices).map((value) => toSafeNumber(value, -1));
    if (normalizedOutcomes.length === 0 || normalizedOutcomes.length !== normalizedPrices.length) {
        return '';
    }

    const winnerIndex = normalizedPrices.findIndex((value) => value >= 0.999);
    if (winnerIndex < 0) {
        return '';
    }

    const losingCount = normalizedPrices.filter(
        (value, index) => index !== winnerIndex && value <= 0.001
    ).length;
    if (losingCount !== normalizedPrices.length - 1) {
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
    const { winnerOutcome, closed, acceptingOrders, umaResolutionStatus = '' } = params;
    const normalizedUmaStatus = String(umaResolutionStatus || '')
        .trim()
        .toLowerCase();

    if (winnerOutcome) {
        return 'resolved';
    }

    if (
        normalizedUmaStatus.includes('resolved') ||
        normalizedUmaStatus.includes('finalized') ||
        normalizedUmaStatus.includes('settled')
    ) {
        return 'resolved';
    }

    if (closed || acceptingOrders === false) {
        return 'closed';
    }

    return 'open';
};

const normalizeConditionId = (value: string) => String(value || '').trim();
const buildResolutionCacheKey = (params: FetchPolymarketMarketResolutionParams) =>
    normalizeConditionId(params.conditionId || '') ||
    `slug:${String(params.marketSlug || '').trim()}`;

const fetchClobMarketResolution = async (
    conditionId: string
): Promise<PolymarketMarketResolution | null> => {
    if (!conditionId) {
        return null;
    }

    const response = await fetchData<ClobMarketResponse>(
        `${ENV.CLOB_HTTP_URL.replace(/\/+$/, '')}/markets/${conditionId}`
    );
    if (!response || typeof response !== 'object') {
        return null;
    }

    const winnerOutcome = inferWinnerFromTokens(response.tokens || []);
    const marketSlug =
        String(response.market_slug || '').trim() || String(response.marketSlug || '').trim();

    return {
        conditionId: normalizeConditionId(
            response.condition_id || response.conditionId || conditionId
        ),
        marketSlug,
        marketUrl: buildMarketUrl(marketSlug),
        resolvedStatus: deriveResolvedStatus({
            winnerOutcome,
            closed: Boolean(response.closed),
            acceptingOrders:
                typeof response.accepting_orders === 'boolean'
                    ? response.accepting_orders
                    : typeof response.acceptingOrders === 'boolean'
                      ? response.acceptingOrders
                      : null,
        }),
        winnerOutcome,
        title: String(response.question || '').trim(),
        updateDescription:
            winnerOutcome || Boolean(response.closed)
                ? `source=clob closed=${Boolean(response.closed)}`
                : 'source=clob unresolved',
        source: 'clob',
        closed: Boolean(response.closed),
        acceptingOrders:
            typeof response.accepting_orders === 'boolean'
                ? response.accepting_orders
                : typeof response.acceptingOrders === 'boolean'
                  ? response.acceptingOrders
                  : null,
        active: typeof response.active === 'boolean' ? response.active : null,
        archived: typeof response.archived === 'boolean' ? response.archived : null,
    };
};

const fetchGammaMarketBySlug = async (marketSlug: string): Promise<GammaMarketResponse | null> => {
    if (!marketSlug) {
        return null;
    }

    const bySlug = await fetchData<GammaMarketResponse | GammaMarketResponse[]>(
        `${GAMMA_API_BASE_URL}/markets/slug/${marketSlug}`
    );
    if (Array.isArray(bySlug)) {
        return bySlug[0] || null;
    }

    if (bySlug && typeof bySlug === 'object') {
        return bySlug;
    }

    const listResponse = await fetchData<GammaMarketResponse[]>(
        `${GAMMA_API_BASE_URL}/markets?slug=${encodeURIComponent(marketSlug)}`
    );

    return Array.isArray(listResponse) ? listResponse[0] || null : null;
};

const fetchGammaMarketResolution = async (
    params: FetchPolymarketMarketResolutionParams
): Promise<PolymarketMarketResolution | null> => {
    const normalizedMarketSlug = String(params.marketSlug || '').trim();
    if (!normalizedMarketSlug) {
        return null;
    }

    const response = await fetchGammaMarketBySlug(normalizedMarketSlug);
    if (!response) {
        return null;
    }

    const winnerOutcome =
        inferWinnerFromTokens(response.tokens || []) ||
        inferWinnerFromOutcomePrices(response.outcomes, response.outcomePrices);

    return {
        conditionId: normalizeConditionId(response.conditionId || params.conditionId || ''),
        marketSlug: normalizedMarketSlug,
        marketUrl: buildMarketUrl(normalizedMarketSlug),
        resolvedStatus: deriveResolvedStatus({
            winnerOutcome,
            closed: Boolean(response.closed),
            acceptingOrders:
                typeof response.acceptingOrders === 'boolean' ? response.acceptingOrders : null,
            umaResolutionStatus: response.umaResolutionStatus,
        }),
        winnerOutcome,
        title: String(response.question || params.title || '').trim(),
        updateDescription: `source=gamma umaResolutionStatus=${String(response.umaResolutionStatus || '').trim()}`,
        source: 'gamma',
        closed: Boolean(response.closed),
        acceptingOrders:
            typeof response.acceptingOrders === 'boolean' ? response.acceptingOrders : null,
        active: typeof response.active === 'boolean' ? response.active : null,
        archived: typeof response.archived === 'boolean' ? response.archived : null,
    };
};

const getOffsetMinutes = (date: Date, timeZone: string) => {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
    });
    const timeZoneName =
        formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
    const matched = timeZoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!matched) {
        return 0;
    }

    const [, sign, hour, minute = '0'] = matched;
    const minutes = Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10);
    return sign === '+' ? minutes : -minutes;
};

const parseTimeToHourMinute = (timePart: string) => {
    const rawHour = Number.parseInt(timePart.slice(0, timePart.indexOf(':')), 10);
    const minute = Number.parseInt(timePart.slice(timePart.indexOf(':') + 1, -2), 10);
    const ampm = timePart.slice(-2);
    let hour = rawHour;

    if (ampm === 'AM') {
        if (hour === 12) {
            hour = 0;
        }
    } else if (hour !== 12) {
        hour += 12;
    }

    return {
        hour,
        minute,
    };
};

export const normalizeOutcomeLabel = (value: string) =>
    String(value || '')
        .trim()
        .toLowerCase();

export const buildPolymarketMarketSlugFromTitle = (title: string) => {
    const matched = String(title || '').match(TITLE_RE);
    if (!matched) {
        return '';
    }

    const [, monthName, dayString, startPart, endPart] = matched;
    const monthIndex = MONTH_INDEX[monthName];
    if (monthIndex === undefined) {
        return '';
    }

    const day = Number.parseInt(dayString, 10);
    const startTime = parseTimeToHourMinute(startPart);
    const endTime = parseTimeToHourMinute(endPart);
    const year = new Date().getUTCFullYear();

    const localStartAsUtc = new Date(
        Date.UTC(year, monthIndex, day, startTime.hour, startTime.minute, 0)
    );
    const startOffsetMinutes = getOffsetMinutes(localStartAsUtc, NEW_YORK_TIME_ZONE);
    const startUtc = new Date(localStartAsUtc.getTime() - startOffsetMinutes * 60_000);

    const localEndAsUtc = new Date(
        Date.UTC(year, monthIndex, day, endTime.hour, endTime.minute, 0)
    );
    const endOffsetMinutes = getOffsetMinutes(localEndAsUtc, NEW_YORK_TIME_ZONE);
    const endUtc = new Date(localEndAsUtc.getTime() - endOffsetMinutes * 60_000);

    const durationMinutes = Math.round((endUtc.getTime() - startUtc.getTime()) / 60_000);
    if (durationMinutes <= 0) {
        return '';
    }

    return `btc-updown-${durationMinutes}m-${Math.floor(startUtc.getTime() / 1000)}`;
};

export const isResolvedPolymarketMarket = (resolution: PolymarketMarketResolution | null) => {
    const normalizedStatus = String(resolution?.resolvedStatus || '')
        .trim()
        .toLowerCase();
    return (
        (normalizedStatus === 'resolved' || normalizedStatus === 'closed') &&
        normalizeOutcomeLabel(resolution?.winnerOutcome || '') !== ''
    );
};

export const isTradablePolymarketMarket = (resolution: PolymarketMarketResolution | null) => {
    if (!resolution) {
        return true;
    }

    const normalizedStatus = String(resolution.resolvedStatus || '')
        .trim()
        .toLowerCase();

    if (normalizedStatus === 'resolved' || normalizedStatus === 'closed') {
        return false;
    }

    if (resolution.closed || resolution.acceptingOrders === false) {
        return false;
    }

    if (resolution.active === false || resolution.archived === true) {
        return false;
    }

    return true;
};

export const fetchPolymarketMarketResolution = async (
    params: FetchPolymarketMarketResolutionParams
): Promise<PolymarketMarketResolution | null> => {
    const normalizedConditionId = normalizeConditionId(params.conditionId || '');
    const normalizedMarketSlug = String(params.marketSlug || '').trim();
    const cacheKey = buildResolutionCacheKey({
        conditionId: normalizedConditionId,
        marketSlug: normalizedMarketSlug,
    });
    const cached = resolutionCache.get(cacheKey);
    if (cached) {
        const ttl = isResolvedPolymarketMarket(cached.resolution)
            ? RESOLUTION_CACHE_RESOLVED_TTL_MS
            : RESOLUTION_CACHE_UNRESOLVED_TTL_MS;
        if (Date.now() - cached.checkedAt < ttl) {
            return cached.resolution;
        }
    }

    const clobResolution = normalizedConditionId
        ? await fetchClobMarketResolution(normalizedConditionId)
        : null;
    if (clobResolution) {
        const normalizedResolution: PolymarketMarketResolution = {
            ...clobResolution,
            marketSlug: clobResolution.marketSlug || normalizedMarketSlug,
            marketUrl: buildMarketUrl(clobResolution.marketSlug || normalizedMarketSlug),
            title: clobResolution.title || String(params.title || '').trim(),
        };
        if (
            isResolvedPolymarketMarket(normalizedResolution) ||
            !String(normalizedResolution.marketSlug || '').trim()
        ) {
            resolutionCache.set(cacheKey, {
                checkedAt: Date.now(),
                resolution: normalizedResolution,
            });
            return normalizedResolution;
        }

        const gammaResolution = await fetchGammaMarketResolution({
            conditionId: normalizedConditionId,
            marketSlug: normalizedResolution.marketSlug || normalizedMarketSlug,
            title: normalizedResolution.title || params.title,
        });
        const mergedResolution = gammaResolution
            ? {
                  ...normalizedResolution,
                  ...gammaResolution,
                  conditionId: gammaResolution.conditionId || normalizedResolution.conditionId,
                  marketSlug: gammaResolution.marketSlug || normalizedResolution.marketSlug,
                  marketUrl:
                      gammaResolution.marketUrl ||
                      buildMarketUrl(gammaResolution.marketSlug || normalizedResolution.marketSlug),
                  title: gammaResolution.title || normalizedResolution.title,
                  closed: gammaResolution.closed || normalizedResolution.closed,
                  acceptingOrders:
                      gammaResolution.acceptingOrders ?? normalizedResolution.acceptingOrders,
                  active: gammaResolution.active ?? normalizedResolution.active,
                  archived: gammaResolution.archived ?? normalizedResolution.archived,
                  updateDescription: mergeResolutionDescriptions(
                      normalizedResolution.updateDescription,
                      gammaResolution.updateDescription
                  ),
              }
            : normalizedResolution;
        resolutionCache.set(cacheKey, {
            checkedAt: Date.now(),
            resolution: mergedResolution,
        });
        return mergedResolution;
    }

    const gammaResolution = await fetchGammaMarketResolution({
        conditionId: normalizedConditionId,
        marketSlug: normalizedMarketSlug,
        title: params.title,
    });
    resolutionCache.set(cacheKey, {
        checkedAt: Date.now(),
        resolution: gammaResolution,
    });
    return gammaResolution;
};
