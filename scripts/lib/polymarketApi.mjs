const DATA_API_BASE_URL = 'https://data-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_ACTIVITY_LIMIT = 500;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1_000_000_000_000;

const normalizeTimestampToMilliseconds = (rawTimestamp) => {
    const parsed = Number(rawTimestamp);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    const truncated = Math.trunc(parsed);
    return truncated < MILLISECOND_TIMESTAMP_THRESHOLD ? truncated * 1000 : truncated;
};

const normalizeTimestampToSeconds = (rawTimestamp) => {
    const normalized = normalizeTimestampToMilliseconds(rawTimestamp);
    return normalized > 0 ? Math.trunc(normalized / 1000) : 0;
};

const buildRequestHeaders = (userAgent) => ({
    'User-Agent': userAgent || 'polymarket-copytrading-bot/script',
});

const fetchJson = async (url, userAgent) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: buildRequestHeaders(userAgent),
            signal: controller.signal,
        });

        if (!response.ok) {
            let reason = `HTTP ${response.status}`;
            try {
                const payload = await response.json();
                reason = payload?.error || payload?.message || reason;
            } catch {
                // ignore body parsing failure
            }

            return {
                data: null,
                error: reason,
            };
        }

        return {
            data: await response.json(),
            error: '',
        };
    } catch (error) {
        return {
            data: null,
            error: error?.message || '请求 Polymarket API 失败',
        };
    } finally {
        clearTimeout(timeout);
    }
};

export const fetchPolymarketPositions = async (walletAddress, userAgent) => {
    if (!String(walletAddress || '').trim()) {
        return {
            walletAddress: '',
            positions: null,
            error: '未提供钱包地址',
        };
    }

    const { data, error } = await fetchJson(
        `${DATA_API_BASE_URL}/positions?user=${walletAddress}&sizeThreshold=0`,
        userAgent
    );

    return {
        walletAddress,
        positions: Array.isArray(data) ? data : null,
        error,
    };
};

export const fetchPolymarketActivities = async (
    walletAddress,
    {
        sinceTs = 0,
        untilTs = 0,
        limit = DEFAULT_ACTIVITY_LIMIT,
        sortDirection = 'ASC',
        userAgent,
    } = {}
) => {
    if (!String(walletAddress || '').trim()) {
        return {
            walletAddress: '',
            activities: null,
            error: '未提供钱包地址',
        };
    }

    const normalizedSinceTs = normalizeTimestampToSeconds(sinceTs);
    const normalizedUntilTs = normalizeTimestampToSeconds(untilTs || Date.now());

    if (normalizedSinceTs <= 0 || normalizedUntilTs <= 0 || normalizedSinceTs > normalizedUntilTs) {
        return {
            walletAddress,
            activities: null,
            error: '活动抓取时间窗口无效',
        };
    }

    const mergedActivities = [];
    const dedupeKeys = new Set();
    let cursor = normalizedSinceTs;

    while (cursor <= normalizedUntilTs) {
        const params = new URLSearchParams({
            user: walletAddress,
            start: String(cursor),
            end: String(normalizedUntilTs),
            limit: String(Math.max(Number(limit) || DEFAULT_ACTIVITY_LIMIT, 1)),
            sortDirection: sortDirection === 'DESC' ? 'DESC' : 'ASC',
        });
        const { data, error } = await fetchJson(
            `${DATA_API_BASE_URL}/activity?${params.toString()}`,
            userAgent
        );

        if (!Array.isArray(data)) {
            return {
                walletAddress,
                activities: null,
                error: error || '获取 Polymarket 活动失败',
            };
        }

        for (const activity of data) {
            const timestamp = normalizeTimestampToMilliseconds(activity?.timestamp);
            const activityKey = String(
                activity?.id ||
                    activity?.activityKey ||
                    activity?.transactionHash ||
                    `${activity?.timestamp || ''}:${activity?.asset || ''}:${activity?.side || ''}`
            ).trim();
            if (!activityKey || dedupeKeys.has(activityKey)) {
                continue;
            }

            dedupeKeys.add(activityKey);
            mergedActivities.push({
                ...activity,
                activityKey,
                timestamp,
            });
        }

        if (data.length < limit) {
            break;
        }

        const lastTimestamp = [...data]
            .reverse()
            .map((item) => normalizeTimestampToSeconds(item?.timestamp))
            .find((timestamp) => timestamp > 0);
        if (!lastTimestamp) {
            break;
        }

        const nextCursor = lastTimestamp + 1;
        if (nextCursor <= cursor) {
            break;
        }

        cursor = nextCursor;
    }

    return {
        walletAddress,
        activities: mergedActivities.sort((left, right) =>
            left.timestamp === right.timestamp
                ? String(left.activityKey || '').localeCompare(String(right.activityKey || ''))
                : left.timestamp - right.timestamp
        ),
        error: '',
    };
};
