const repetitiveUpdownSlugPattern = /(?:^|[-_])(5m|15m)-(\d{10})(?:$|[-_])/i;

const resolveDurationMs = (durationText: string) => {
    const normalized = String(durationText || '')
        .trim()
        .toLowerCase();
    if (normalized === '5m') {
        return 5 * 60_000;
    }
    if (normalized === '15m') {
        return 15 * 60_000;
    }

    return null;
};

export const resolveRepetitiveMarketWindow = (market: { slug?: string; eventSlug?: string }) => {
    const slugCandidates = [market.eventSlug, market.slug]
        .map((value) =>
            String(value || '')
                .trim()
                .toLowerCase()
        )
        .filter(Boolean);

    for (const candidate of slugCandidates) {
        const match = candidate.match(repetitiveUpdownSlugPattern);
        if (!match) {
            continue;
        }

        const durationMs = resolveDurationMs(match[1]);
        const startTimestampSec = Number.parseInt(match[2] || '', 10);
        if (!durationMs || !Number.isInteger(startTimestampSec) || startTimestampSec <= 0) {
            continue;
        }

        const startTimeMs = startTimestampSec * 1000;
        return {
            startTimeMs,
            endTimeMs: startTimeMs + durationMs,
            durationMs,
        };
    }

    return null;
};

export const isMarketWindowClosed = (
    market: {
        slug?: string;
        eventSlug?: string;
    },
    nowMs: number
) => {
    const window = resolveRepetitiveMarketWindow(market);
    if (!window) {
        return false;
    }

    return nowMs >= window.endTimeMs;
};
