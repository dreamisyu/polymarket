import axios from 'axios';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import mongoose from 'mongoose';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT_DIR = resolve(__dirname, '..');
const ENV_PATH_CANDIDATES = Array.from(
    new Set([resolve(process.cwd(), '.env'), resolve(PROJECT_ROOT_DIR, '.env')])
);
const ENV_FILE_PATH =
    ENV_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    resolve(PROJECT_ROOT_DIR, '.env');

dotenv.config({ path: ENV_FILE_PATH });

const NEW_YORK_TIME_ZONE = 'America/New_York';
const TITLE_RE =
    /^Bitcoin Up or Down - ([A-Za-z]+) (\d+), (\d{1,2}:\d{2}[AP]M)-(\d{1,2}:\d{2}[AP]M) ET$/;
const MONTH_INDEX = {
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
const DEFAULT_TRACE_ID = process.env.TRACE_ID || 'default';
const DEFAULT_USER_ADDRESS = process.env.USER_ADDRESS || '';
const DEFAULT_MONGO_URI = process.env.MONGO_URI || '';
const DEFAULT_TOP_CONDITIONS = 10;
const DEFAULT_TOP_SKIP_REASONS = 5;

const parseArgs = (argv) => {
    const parsed = {
        traceId: DEFAULT_TRACE_ID,
        userAddress: DEFAULT_USER_ADDRESS,
        mongoUri: DEFAULT_MONGO_URI,
        json: false,
        help: false,
        conditionIds: [],
        topConditions: DEFAULT_TOP_CONDITIONS,
        topSkipReasons: DEFAULT_TOP_SKIP_REASONS,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];

        if (current === '--json') {
            parsed.json = true;
            continue;
        }

        if (current === '--help' || current === '-h') {
            parsed.help = true;
            continue;
        }

        if ((current === '--trace-id' || current === '-t') && argv[index + 1]) {
            parsed.traceId = argv[index + 1];
            index += 1;
            continue;
        }

        if ((current === '--user-address' || current === '-u') && argv[index + 1]) {
            parsed.userAddress = argv[index + 1];
            index += 1;
            continue;
        }

        if ((current === '--mongo-uri' || current === '-m') && argv[index + 1]) {
            parsed.mongoUri = argv[index + 1];
            index += 1;
            continue;
        }

        if ((current === '--condition-id' || current === '-c') && argv[index + 1]) {
            parsed.conditionIds.push(
                ...argv[index + 1]
                    .split(',')
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            );
            index += 1;
            continue;
        }

        if (current === '--top-conditions' && argv[index + 1]) {
            parsed.topConditions = Math.max(Number.parseInt(argv[index + 1], 10) || 0, 1);
            index += 1;
            continue;
        }

        if (current === '--top-skip-reasons' && argv[index + 1]) {
            parsed.topSkipReasons = Math.max(Number.parseInt(argv[index + 1], 10) || 0, 1);
            index += 1;
        }
    }

    parsed.conditionIds = Array.from(new Set(parsed.conditionIds));
    return parsed;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/trace-settlement-audit.mjs [--trace-id default] [--user-address 0x...] [--mongo-uri mongodb://...] [--condition-id 0x...,0x...] [--top-conditions 10] [--json]

说明:
  1. 默认读取当前工作目录或项目根目录的 .env
  2. 脚本会读取 trace 持仓/执行记录，并对照 Polymarket 官方 REST 市场接口的实际结算结果
  3. 默认审计 trace 持仓、执行记录、源活动里出现过的全部 condition，可通过 --condition-id 限定范围
  4. --json 可输出机器可读结果，便于后续接入告警或 CI
`);
    process.exit(0);
}

const requireArg = (value, name) => {
    if (!value) {
        throw new Error(`${name} 未定义（当前加载自 ${ENV_FILE_PATH}）`);
    }

    return value;
};

const toSafeNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeKey = (value) =>
    String(value || '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase();

const sumBy = (items, getter) => items.reduce((sum, item) => sum + toSafeNumber(getter(item)), 0);
const formatUsd = (value) => `${toSafeNumber(value).toFixed(6)} USDC`;
const formatNumber = (value) => toSafeNumber(value).toFixed(6);
const unique = (items) => Array.from(new Set(items));
const collectConditionIds = (...groups) =>
    unique(
        groups
            .flatMap((items) => items)
            .map((item) => String(item?.conditionId || '').trim())
            .filter(Boolean)
    );

const getTraceCollectionNames = (walletAddress, traceId) => {
    const suffix = `${normalizeKey(walletAddress)}_${normalizeKey(traceId)}`;
    return {
        execution: `trace_executions_${suffix}`,
        position: `trace_positions_${suffix}`,
        portfolio: `trace_portfolios_${suffix}`,
        sourceActivity: `user_activities_${walletAddress}`,
    };
};

const getCollectionIfExists = async (collectionName) => {
    const collections = await mongoose.connection.db
        .listCollections({ name: collectionName }, { nameOnly: true })
        .toArray();

    if (collections.length === 0) {
        return null;
    }

    return mongoose.connection.db.collection(collectionName);
};

const fetchCollectionDocs = async (collectionName, filter = {}, options = {}) => {
    const collection = await getCollectionIfExists(collectionName);
    if (!collection) {
        return [];
    }

    const { sort = {}, projection = {} } = options;
    return collection.find(filter, { projection }).sort(sort).toArray();
};

const fetchSingleDoc = async (collectionName, filter = {}, options = {}) => {
    const docs = await fetchCollectionDocs(collectionName, filter, options);
    return docs[0] || null;
};

const groupBy = (items, keyGetter) => {
    const result = new Map();
    for (const item of items) {
        const key = keyGetter(item);
        if (!result.has(key)) {
            result.set(key, []);
        }

        result.get(key).push(item);
    }

    return result;
};

const getOffsetMinutes = (date, timeZone) => {
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

const parseTimeToHourMinute = (timePart) => {
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

const buildSlugFromTitle = (title) => {
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

const RESOLUTION_CACHE_RESOLVED_TTL_MS = 10 * 60 * 1000;
const RESOLUTION_CACHE_UNRESOLVED_TTL_MS = 30 * 1000;
const resolutionCache = new Map();

const normalizeOutcomeLabel = (value) =>
    String(value || '')
        .trim()
        .toLowerCase();

const parseArrayLike = (value) => {
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

const inferWinnerFromTokens = (tokens = []) =>
    normalizeOutcomeLabel(tokens.find((token) => token?.winner)?.outcome || '');

const inferWinnerFromOutcomePrices = (outcomes, outcomePrices) => {
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

const deriveResolvedStatus = ({ winner, closed, acceptingOrders, umaResolutionStatus }) => {
    const normalizedUmaStatus = String(umaResolutionStatus || '')
        .trim()
        .toLowerCase();
    if (winner) {
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

const mergeResolutionDescriptions = (...values) =>
    [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].join('；');

const fetchPolymarketPositions = async (walletAddress) => {
    if (!walletAddress) {
        return {
            walletAddress: '',
            positions: [],
            error: '未提供 USER_ADDRESS，无法读取源钱包持仓',
        };
    }

    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0`,
            {
                timeout: 10_000,
                headers: {
                    'User-Agent': 'polymarket-copytrading-bot/trace-settlement-audit',
                },
            }
        );

        return {
            walletAddress,
            positions: Array.isArray(response.data) ? response.data : [],
            error: '',
        };
    } catch (error) {
        return {
            walletAddress,
            positions: [],
            error: error?.response?.data?.error || error?.message || '获取源钱包持仓失败',
        };
    }
};

const fetchGammaMarketBySlug = async (marketSlug) => {
    if (!marketSlug) {
        return null;
    }

    try {
        const bySlugResponse = await axios.get(
            `https://gamma-api.polymarket.com/markets/slug/${marketSlug}`,
            {
                timeout: 10_000,
                headers: {
                    'User-Agent': 'polymarket-copytrading-bot/trace-settlement-audit',
                },
            }
        );

        if (Array.isArray(bySlugResponse.data)) {
            return bySlugResponse.data[0] || null;
        }

        if (bySlugResponse.data && typeof bySlugResponse.data === 'object') {
            return bySlugResponse.data;
        }
    } catch {}

    try {
        const listResponse = await axios.get(
            `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}`,
            {
                timeout: 10_000,
                headers: {
                    'User-Agent': 'polymarket-copytrading-bot/trace-settlement-audit',
                },
            }
        );

        return Array.isArray(listResponse.data) ? listResponse.data[0] || null : null;
    } catch {
        return null;
    }
};

const fetchMarketResolution = async (conditionId, marketSlug, title) => {
    const normalizedConditionId = String(conditionId || '').trim();
    const normalizedMarketSlug = String(marketSlug || '').trim();
    const cacheKey = normalizedConditionId || `slug:${normalizedMarketSlug}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached) {
        const ttl =
            String(cached.resolvedStatus || '').toLowerCase() === 'resolved' &&
            String(cached.winner || '').trim()
                ? RESOLUTION_CACHE_RESOLVED_TTL_MS
                : RESOLUTION_CACHE_UNRESOLVED_TTL_MS;
        if (Date.now() - cached.checkedAt < ttl) {
            return cached.value;
        }
    }

    if (!normalizedConditionId && !normalizedMarketSlug) {
        return {
            marketSlug: '',
            marketUrl: '',
            resolvedStatus: '',
            winner: '',
            title: String(title || '').trim(),
            updateDescription: '',
            error: '缺少 conditionId 与市场 slug，无法查询官方 REST 市场接口',
        };
    }

    try {
        const clobResolution = normalizedConditionId
            ? await axios.get(`https://clob.polymarket.com/markets/${normalizedConditionId}`, {
                  timeout: 10_000,
                  headers: {
                      'User-Agent': 'polymarket-copytrading-bot/trace-settlement-audit',
                  },
              })
            : null;
        const clobMarket =
            clobResolution?.data && typeof clobResolution.data === 'object'
                ? clobResolution.data
                : null;
        const winner = inferWinnerFromTokens(clobMarket?.tokens || []);
        const nextMarketSlug = String(clobMarket?.market_slug || '').trim() || normalizedMarketSlug;
        const value = {
            marketSlug: nextMarketSlug,
            marketUrl: nextMarketSlug
                ? `https://polymarket.com/event/${nextMarketSlug}/${nextMarketSlug}`
                : '',
            resolvedStatus: deriveResolvedStatus({
                winner,
                closed: Boolean(clobMarket?.closed),
                acceptingOrders:
                    typeof clobMarket?.accepting_orders === 'boolean'
                        ? clobMarket.accepting_orders
                        : null,
            }),
            winner,
            title: String(clobMarket?.question || title || '').trim(),
            updateDescription: winner
                ? `source=clob winner=${winner}`
                : `source=clob closed=${Boolean(clobMarket?.closed)}`,
            error: '',
        };
        if (String(value.resolvedStatus || '').toLowerCase() === 'resolved' || !nextMarketSlug) {
            resolutionCache.set(cacheKey, {
                checkedAt: Date.now(),
                resolvedStatus: value.resolvedStatus,
                winner: value.winner,
                value,
            });
            return value;
        }

        const gammaMarket = await fetchGammaMarketBySlug(nextMarketSlug);
        if (gammaMarket) {
            const gammaWinner =
                inferWinnerFromTokens(gammaMarket.tokens || []) ||
                inferWinnerFromOutcomePrices(gammaMarket.outcomes, gammaMarket.outcomePrices);
            const mergedValue = {
                ...value,
                resolvedStatus: deriveResolvedStatus({
                    winner: gammaWinner || value.winner,
                    closed: Boolean(gammaMarket.closed || clobMarket?.closed),
                    acceptingOrders:
                        typeof gammaMarket.acceptingOrders === 'boolean'
                            ? gammaMarket.acceptingOrders
                            : typeof clobMarket?.accepting_orders === 'boolean'
                              ? clobMarket.accepting_orders
                              : null,
                    umaResolutionStatus: gammaMarket.umaResolutionStatus,
                }),
                winner: gammaWinner || value.winner,
                title: String(gammaMarket.question || value.title || title || '').trim(),
                updateDescription: mergeResolutionDescriptions(
                    value.updateDescription,
                    `source=gamma umaResolutionStatus=${String(gammaMarket.umaResolutionStatus || '').trim()}`
                ),
            };
            resolutionCache.set(cacheKey, {
                checkedAt: Date.now(),
                resolvedStatus: mergedValue.resolvedStatus,
                winner: mergedValue.winner,
                value: mergedValue,
            });
            return mergedValue;
        }

        resolutionCache.set(cacheKey, {
            checkedAt: Date.now(),
            resolvedStatus: value.resolvedStatus,
            winner: value.winner,
            value,
        });
        return value;
    } catch (clobError) {
        const gammaMarket = await fetchGammaMarketBySlug(normalizedMarketSlug);
        if (gammaMarket) {
            const winner =
                inferWinnerFromTokens(gammaMarket.tokens || []) ||
                inferWinnerFromOutcomePrices(gammaMarket.outcomes, gammaMarket.outcomePrices);
            const value = {
                marketSlug: normalizedMarketSlug,
                marketUrl: normalizedMarketSlug
                    ? `https://polymarket.com/event/${normalizedMarketSlug}/${normalizedMarketSlug}`
                    : '',
                resolvedStatus: deriveResolvedStatus({
                    winner,
                    closed: Boolean(gammaMarket.closed),
                    acceptingOrders:
                        typeof gammaMarket.acceptingOrders === 'boolean'
                            ? gammaMarket.acceptingOrders
                            : null,
                    umaResolutionStatus: gammaMarket.umaResolutionStatus,
                }),
                winner,
                title: String(gammaMarket.question || title || '').trim(),
                updateDescription: `source=gamma umaResolutionStatus=${String(gammaMarket.umaResolutionStatus || '').trim()}`,
                error: '',
            };
            resolutionCache.set(cacheKey, {
                checkedAt: Date.now(),
                resolvedStatus: value.resolvedStatus,
                winner: value.winner,
                value,
            });
            return value;
        }

        return {
            marketSlug: normalizedMarketSlug,
            marketUrl: normalizedMarketSlug
                ? `https://polymarket.com/event/${normalizedMarketSlug}/${normalizedMarketSlug}`
                : '',
            resolvedStatus: '',
            winner: '',
            title: String(title || '').trim(),
            updateDescription: '',
            error:
                clobError?.response?.data?.error ||
                clobError?.message ||
                '读取官方 REST 市场接口失败',
        };
    }
};

const selectConditionMetadata = (activities, positions) => {
    const sortedActivities = [...activities].sort(
        (left, right) => toSafeNumber(right.timestamp) - toSafeNumber(left.timestamp)
    );
    const activityWithSlug = sortedActivities.find(
        (item) => String(item.eventSlug || item.slug || '').trim() !== ''
    );
    const representative = activityWithSlug || sortedActivities[0] || positions[0] || {};
    const marketSlug =
        String(representative.eventSlug || representative.slug || '').trim() ||
        buildSlugFromTitle(representative.title || positions[0]?.title || '');

    return {
        title: representative.title || positions[0]?.title || '',
        marketSlug,
    };
};

const buildSkipReasonSummary = (executions, limit) =>
    [
        ...groupBy(
            executions.filter((item) => item.status === 'SKIPPED'),
            (item) => item.reason
        ).entries(),
    ]
        .map(([reason, items]) => ({
            reason: String(reason || '').trim() || '未知原因',
            count: items.length,
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, limit);

const buildExecutionConditionSummary = (executions) =>
    [...groupBy(executions, (item) => item.executionCondition || 'unknown').entries()]
        .map(([executionCondition, items]) => ({
            executionCondition,
            count: items.length,
            filledCount: items.filter((item) => item.status === 'FILLED').length,
            skippedCount: items.filter((item) => item.status === 'SKIPPED').length,
            failedCount: items.filter((item) => item.status === 'FAILED').length,
        }))
        .sort((left, right) => right.count - left.count);

const buildSourceActivitySummary = (activities) =>
    [
        ...groupBy(
            activities,
            (item) =>
                `${item.type || 'UNKNOWN'}|${item.executionIntent || 'UNKNOWN'}|${item.botStatus || 'UNKNOWN'}`
        ).entries(),
    ]
        .map(([key, items]) => {
            const [type, executionIntent, botStatus] = key.split('|');
            return {
                type,
                executionIntent,
                botStatus,
                count: items.length,
            };
        })
        .sort((left, right) => right.count - left.count);

const isResolved = (resolution) =>
    String(resolution?.resolvedStatus || '').toLowerCase() === 'resolved';

const main = async () => {
    const traceId = requireArg(argv.traceId, 'TRACE_ID');
    const userAddress = requireArg(argv.userAddress, 'USER_ADDRESS');
    const mongoUri = requireArg(argv.mongoUri, 'MONGO_URI');
    const collectionNames = getTraceCollectionNames(userAddress, traceId);

    await mongoose.connect(mongoUri);

    try {
        const [positions, portfolio, executions, sourceActivities] = await Promise.all([
            fetchCollectionDocs(
                collectionNames.position,
                argv.conditionIds.length > 0 ? { conditionId: { $in: argv.conditionIds } } : {},
                {
                    sort: { lastTradedAt: -1, updatedAt: -1 },
                    projection: {
                        _id: 0,
                        conditionId: 1,
                        asset: 1,
                        title: 1,
                        outcome: 1,
                        size: 1,
                        costBasis: 1,
                        marketPrice: 1,
                        marketValue: 1,
                        unrealizedPnl: 1,
                        realizedPnl: 1,
                        closedAt: 1,
                        lastTradedAt: 1,
                    },
                }
            ),
            fetchSingleDoc(collectionNames.portfolio, {}, { sort: { updatedAt: -1 } }),
            fetchCollectionDocs(
                collectionNames.execution,
                argv.conditionIds.length > 0 ? { conditionId: { $in: argv.conditionIds } } : {},
                {
                    sort: { sourceTimestamp: -1 },
                    projection: {
                        _id: 0,
                        conditionId: 1,
                        executionCondition: 1,
                        status: 1,
                        reason: 1,
                        sourceTimestamp: 1,
                    },
                }
            ),
            fetchCollectionDocs(
                collectionNames.sourceActivity,
                argv.conditionIds.length > 0 ? { conditionId: { $in: argv.conditionIds } } : {},
                {
                    sort: { timestamp: -1 },
                    projection: {
                        _id: 0,
                        conditionId: 1,
                        type: 1,
                        title: 1,
                        outcome: 1,
                        slug: 1,
                        eventSlug: 1,
                        timestamp: 1,
                        executionIntent: 1,
                        botStatus: 1,
                    },
                }
            ),
        ]);

        const effectiveConditionIds =
            argv.conditionIds.length > 0
                ? argv.conditionIds
                : collectConditionIds(positions, executions, sourceActivities);

        const filteredPositions = positions.filter((item) =>
            effectiveConditionIds.includes(String(item.conditionId || '').trim())
        );
        const filteredExecutions = executions.filter((item) =>
            effectiveConditionIds.includes(String(item.conditionId || '').trim())
        );
        const filteredActivities = sourceActivities.filter((item) =>
            effectiveConditionIds.includes(String(item.conditionId || '').trim())
        );
        const positionsByCondition = groupBy(filteredPositions, (item) => item.conditionId);
        const activitiesByCondition = groupBy(filteredActivities, (item) => item.conditionId);
        const sourcePositionsResponse = await fetchPolymarketPositions(userAddress);
        const currentSourcePositions = sourcePositionsResponse.positions.filter((item) =>
            effectiveConditionIds.includes(String(item.conditionId || '').trim())
        );
        const currentSourcePositionsByCondition = groupBy(
            currentSourcePositions,
            (item) => item.conditionId
        );

        const conditions = effectiveConditionIds
            .map((conditionId) => ({
                conditionId,
                positions: positionsByCondition.get(conditionId) || [],
                activities: activitiesByCondition.get(conditionId) || [],
            }))
            .filter((item) => item.positions.length > 0 || item.activities.length > 0);

        const conditionDetails = await Promise.all(
            conditions.map(async ({ conditionId, positions: localPositions, activities }) => {
                const metadata = selectConditionMetadata(activities, localPositions);
                const resolution = await fetchMarketResolution(
                    conditionId,
                    metadata.marketSlug,
                    metadata.title
                );
                const winnerPosition = localPositions.find(
                    (item) =>
                        String(item.outcome || '')
                            .trim()
                            .toLowerCase() ===
                        String(resolution.winner || '')
                            .trim()
                            .toLowerCase()
                );
                const currentValue = sumBy(localPositions, (item) => item.marketValue);
                const totalCost = sumBy(localPositions, (item) => item.costBasis);
                const priceSum = sumBy(localPositions, (item) => item.marketPrice);
                const samePrice =
                    localPositions.length === 2 &&
                    Math.abs(
                        toSafeNumber(localPositions[0]?.marketPrice) -
                            toSafeNumber(localPositions[1]?.marketPrice)
                    ) < 1e-9;
                const impossibleBinaryPrice =
                    localPositions.length === 2 &&
                    (samePrice || priceSum < 0.99 || priceSum > 1.01);
                const expectedValue = isResolved(resolution)
                    ? toSafeNumber(winnerPosition?.size)
                    : currentValue;
                const localSettleExecutions = filteredExecutions.filter(
                    (item) =>
                        item.conditionId === conditionId &&
                        item.executionCondition === 'settle' &&
                        item.status === 'FILLED'
                ).length;
                const sourceTypeCounts = buildSourceActivitySummary(activities);
                const sourceCurrentPositionsForCondition =
                    currentSourcePositionsByCondition.get(conditionId) || [];

                return {
                    conditionId,
                    title: metadata.title || resolution.title || localPositions[0]?.title || '',
                    marketSlug: metadata.marketSlug,
                    marketUrl: resolution.marketUrl,
                    resolvedStatus: resolution.resolvedStatus,
                    winner: resolution.winner,
                    updateDescription: resolution.updateDescription,
                    resolutionError: resolution.error,
                    local: {
                        positionCount: localPositions.length,
                        openOutcomeCount: localPositions.filter(
                            (item) => toSafeNumber(item.size) > 0
                        ).length,
                        currentValue,
                        totalCost,
                        expectedValue,
                        mispricingDelta: currentValue - expectedValue,
                        winningSize: toSafeNumber(winnerPosition?.size),
                        impossibleBinaryPrice,
                        priceSum,
                        samePrice,
                        outcomes: localPositions
                            .map((item) => ({
                                outcome: item.outcome,
                                asset: item.asset,
                                size: toSafeNumber(item.size),
                                costBasis: toSafeNumber(item.costBasis),
                                marketPrice: toSafeNumber(item.marketPrice),
                                marketValue: toSafeNumber(item.marketValue),
                            }))
                            .sort((left, right) =>
                                String(left.outcome || '').localeCompare(
                                    String(right.outcome || '')
                                )
                            ),
                        settleExecutionCount: localSettleExecutions,
                    },
                    source: {
                        activitySummary: sourceTypeCounts,
                        currentPositionsMatched: sourceCurrentPositionsForCondition.length,
                        currentPositions: sourceCurrentPositionsForCondition.map((item) => ({
                            outcome: item.outcome,
                            asset: item.asset,
                            size: toSafeNumber(item.size),
                            curPrice: toSafeNumber(item.curPrice),
                            currentValue: toSafeNumber(item.currentValue),
                            redeemable: Boolean(item.redeemable),
                            mergeable: Boolean(item.mergeable),
                        })),
                    },
                };
            })
        );

        const hasExplicitConditionFilter = argv.conditionIds.length > 0;
        const resolvedWithWinner = conditionDetails.filter(
            (item) => isResolved(item) && String(item.winner || '').trim() !== ''
        );
        const expectedPositionValue = sumBy(conditionDetails, (item) => item.local.expectedValue);
        const currentPositionValue = sumBy(conditionDetails, (item) => item.local.currentValue);
        const cashBalance = toSafeNumber(portfolio?.cashBalance);
        const globalCurrentTotalEquity =
            portfolio?.totalEquity !== undefined
                ? toSafeNumber(portfolio.totalEquity)
                : cashBalance + currentPositionValue;
        const globalCurrentNetPnl =
            portfolio?.netPnl !== undefined
                ? toSafeNumber(portfolio.netPnl)
                : globalCurrentTotalEquity - toSafeNumber(portfolio?.initialBalance);
        const expectedTotalEquity = hasExplicitConditionFilter
            ? null
            : cashBalance + expectedPositionValue;
        const impossibleBinaryConditions = conditionDetails.filter(
            (item) => item.local.impossibleBinaryPrice
        );
        const sourcePositionMatchedConditions = unique(
            currentSourcePositions
                .map((item) => String(item.conditionId || '').trim())
                .filter(Boolean)
        );

        const summary = {
            generatedAt: new Date().toISOString(),
            envPath: ENV_FILE_PATH,
            traceId,
            userAddress,
            mongoUri,
            scope: {
                conditionIds: effectiveConditionIds,
                conditionCount: effectiveConditionIds.length,
                hasExplicitConditionFilter,
                derivedFrom: hasExplicitConditionFilter
                    ? 'cli'
                    : 'positions+executions+sourceActivities',
            },
            collections: collectionNames,
            portfolio: {
                scope: 'global',
                initialBalance: toSafeNumber(portfolio?.initialBalance),
                cashBalance,
                currentPositionsMarketValue:
                    portfolio?.positionsMarketValue !== undefined
                        ? toSafeNumber(portfolio.positionsMarketValue)
                        : currentPositionValue,
                currentTotalEquity: globalCurrentTotalEquity,
                currentNetPnl: globalCurrentNetPnl,
            },
            scoped: {
                scope: hasExplicitConditionFilter ? 'condition-filtered' : 'all-conditions',
                currentPositionValue,
                expectedPositionValue,
                positionValueDelta: currentPositionValue - expectedPositionValue,
            },
            expected: {
                expectedTotalEquity,
                expectedNetPnl:
                    expectedTotalEquity === null
                        ? null
                        : expectedTotalEquity - toSafeNumber(portfolio?.initialBalance),
                equityDeltaVsCurrent:
                    expectedTotalEquity === null
                        ? null
                        : globalCurrentTotalEquity - expectedTotalEquity,
            },
            localExecutionSummary: {
                totalExecutions: filteredExecutions.length,
                filledCount: filteredExecutions.filter((item) => item.status === 'FILLED').length,
                skippedCount: filteredExecutions.filter((item) => item.status === 'SKIPPED').length,
                failedCount: filteredExecutions.filter((item) => item.status === 'FAILED').length,
                settleFilledCount: filteredExecutions.filter(
                    (item) => item.executionCondition === 'settle' && item.status === 'FILLED'
                ).length,
                executionConditionSummary: buildExecutionConditionSummary(filteredExecutions),
                topSkippedReasons: buildSkipReasonSummary(filteredExecutions, argv.topSkipReasons),
            },
            sourceSummary: {
                currentPositionsApiError: sourcePositionsResponse.error,
                currentPositionsMatchedConditionCount: sourcePositionMatchedConditions.length,
                currentPositionsMatchedRowCount: currentSourcePositions.length,
                redeemableCount: currentSourcePositions.filter((item) => Boolean(item.redeemable))
                    .length,
                mergeableCount: currentSourcePositions.filter((item) => Boolean(item.mergeable))
                    .length,
                activitySummary: buildSourceActivitySummary(filteredActivities),
            },
            conditionSummary: {
                totalConditions: conditionDetails.length,
                resolvedCount: conditionDetails.filter((item) => isResolved(item)).length,
                resolvedWithWinnerCount: resolvedWithWinner.length,
                impossibleBinaryPriceCount: impossibleBinaryConditions.length,
                unresolvedCount: conditionDetails.filter((item) => !isResolved(item)).length,
                resolutionErrorCount: conditionDetails.filter((item) => item.resolutionError)
                    .length,
            },
            topMismatches: [...conditionDetails]
                .sort(
                    (left, right) =>
                        Math.abs(right.local.mispricingDelta) - Math.abs(left.local.mispricingDelta)
                )
                .slice(0, argv.topConditions),
            allConditions: [...conditionDetails].sort((left, right) =>
                String(left.title || '').localeCompare(String(right.title || ''))
            ),
            warnings: [
                filteredExecutions.filter(
                    (item) => item.executionCondition === 'settle' && item.status === 'FILLED'
                ).length === 0 && resolvedWithWinner.length > 0
                    ? '本地 trace 执行记录中没有 settle 成交，但已检测到多个市场实际已 resolved。'
                    : '',
                sourcePositionMatchedConditions.length === 0 && resolvedWithWinner.length > 0
                    ? '源钱包当前持仓接口已无法返回这些已结算 condition，说明仅依赖 current positions/redeemable 无法完成补结算。'
                    : '',
                impossibleBinaryConditions.length > 0
                    ? `检测到 ${impossibleBinaryConditions.length} 个二元市场价格违反 sum≈1 约束，存在 outcome 错配或标价串边风险。`
                    : '',
                hasExplicitConditionFilter
                    ? '当前启用了 --condition-id，portfolio/cash 仍代表全局组合，请优先关注 scoped 持仓价值偏差。'
                    : '',
            ].filter(Boolean),
        };

        if (argv.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        const lines = [];
        lines.push('Trace 结算审计');
        lines.push(`统计时间: ${summary.generatedAt}`);
        lines.push(`Trace ID: ${traceId}`);
        lines.push(`源钱包: ${userAddress}`);
        lines.push('');
        lines.push('全局组合:');
        lines.push(`- 现金余额: ${formatUsd(summary.portfolio.cashBalance)}`);
        lines.push(`- 当前持仓市值: ${formatUsd(summary.portfolio.currentPositionsMarketValue)}`);
        lines.push(`- 当前总权益: ${formatUsd(summary.portfolio.currentTotalEquity)}`);
        lines.push(`- 当前净收益: ${formatUsd(summary.portfolio.currentNetPnl)}`);
        lines.push('');
        lines.push('当前审计范围:');
        lines.push(`- 当前持仓价值: ${formatUsd(summary.scoped.currentPositionValue)}`);
        lines.push(`- 预期持仓价值: ${formatUsd(summary.scoped.expectedPositionValue)}`);
        lines.push(`- 持仓价值偏差: ${formatUsd(summary.scoped.positionValueDelta)}`);
        if (summary.expected.expectedTotalEquity !== null) {
            lines.push('');
            lines.push('按实际结算重算:');
            lines.push(`- 预期总权益: ${formatUsd(summary.expected.expectedTotalEquity)}`);
            lines.push(`- 相对当前账本偏差: ${formatUsd(summary.expected.equityDeltaVsCurrent)}`);
        }
        lines.push('');
        lines.push('执行概览:');
        lines.push(`- 总执行数: ${summary.localExecutionSummary.totalExecutions}`);
        lines.push(`- FILLED: ${summary.localExecutionSummary.filledCount}`);
        lines.push(`- SKIPPED: ${summary.localExecutionSummary.skippedCount}`);
        lines.push(`- FAILED: ${summary.localExecutionSummary.failedCount}`);
        lines.push(`- settle 成交数: ${summary.localExecutionSummary.settleFilledCount}`);
        lines.push('');
        lines.push('源侧概览:');
        lines.push(
            `- 当前 positions API 匹配 condition 数: ${summary.sourceSummary.currentPositionsMatchedConditionCount}`
        );
        lines.push(
            `- 当前 positions API 匹配持仓行数: ${summary.sourceSummary.currentPositionsMatchedRowCount}`
        );
        lines.push(`- redeemable 行数: ${summary.sourceSummary.redeemableCount}`);
        lines.push(`- mergeable 行数: ${summary.sourceSummary.mergeableCount}`);
        if (summary.sourceSummary.currentPositionsApiError) {
            lines.push(`- positions API 错误: ${summary.sourceSummary.currentPositionsApiError}`);
        }
        lines.push('');
        lines.push('主要跳过原因:');
        summary.localExecutionSummary.topSkippedReasons.forEach((item) => {
            lines.push(`- ${item.count} 次: ${item.reason}`);
        });
        lines.push('');
        lines.push('源活动分布:');
        summary.sourceSummary.activitySummary.forEach((item) => {
            lines.push(
                `- ${item.type} / ${item.executionIntent} / ${item.botStatus}: ${item.count}`
            );
        });
        lines.push('');
        lines.push('偏差最大的市场:');
        summary.topMismatches
            .filter(item=>formatNumber(item.local.mispricingDelta)>0).forEach((item) => {
            lines.push(
                `- ${item.title} | winner=${item.winner || '未知'} | 当前=${formatNumber(
                    item.local.currentValue
                )} | 预期=${formatNumber(item.local.expectedValue)} | 偏差=${formatNumber(
                    item.local.mispricingDelta
                )} | ${item.marketUrl || '无市场链接'}`
            );
        });

        if (summary.warnings.length > 0) {
            lines.push('');
            lines.push('警告:');
            summary.warnings.forEach((item) => {
                lines.push(`- ${item}`);
            });
        }

        console.log(lines.join('\n'));
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((error) => {
    console.error(`trace 审计失败: ${error.message}`);
    process.exit(1);
});
