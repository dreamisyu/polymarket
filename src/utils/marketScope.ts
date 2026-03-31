const parseClockMinutes = (hourText: string, minuteText: string, meridiemText: string) => {
    const hour = Number.parseInt(hourText, 10);
    const minute = Number.parseInt(minuteText, 10);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return Number.NaN;
    }

    const meridiem = String(meridiemText || '')
        .trim()
        .toLowerCase();
    let normalizedHour = hour % 12;
    if (meridiem === 'pm') {
        normalizedHour += 12;
    }

    return normalizedHour * 60 + minute;
};

const isFiveMinuteUpdownTitle = (normalizedTitle: string) => {
    const match = normalizedTitle.match(
        /(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)\s*et/i
    );
    if (!match) {
        return false;
    }

    const startMinutes = parseClockMinutes(match[1], match[2], match[3]);
    const endMinutes = parseClockMinutes(match[4], match[5], match[6]);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
        return false;
    }

    const diff =
        endMinutes >= startMinutes
            ? endMinutes - startMinutes
            : endMinutes + 24 * 60 - startMinutes;
    return diff === 5;
};

const cryptoUpdownFiveMinuteSlugPattern = /(?:^|[-_])(btc|eth)-updown-5m(?:$|[-_])/i;
const cryptoUpdownFiveMinuteTitlePattern = /(bitcoin|ethereum)\s+up\s+or\s+down/i;

const normalizeMarketText = (value?: string) =>
    String(value || '')
        .trim()
        .toLowerCase();

export const isTradeWithinCryptoUpdownFiveMinuteScope = (trade: {
    title?: string;
    slug?: string;
    eventSlug?: string;
}) => {
    const normalizedSlug = normalizeMarketText(trade.slug);
    const normalizedEventSlug = normalizeMarketText(trade.eventSlug);
    const normalizedTitle = String(trade.title || '')
        .trim()
        .toLowerCase();

    if (
        cryptoUpdownFiveMinuteSlugPattern.test(normalizedSlug) ||
        cryptoUpdownFiveMinuteSlugPattern.test(normalizedEventSlug)
    ) {
        return true;
    }

    return (
        cryptoUpdownFiveMinuteTitlePattern.test(normalizedTitle) &&
        isFiveMinuteUpdownTitle(normalizedTitle)
    );
};

export const isTradeWithinMarketWhitelist = (
    trade: { title?: string; slug?: string; eventSlug?: string },
    marketWhitelist: string[]
) => {
    const normalizedRules = Array.from(
        new Set(
            marketWhitelist
                .map((rule) => normalizeMarketText(rule))
                .filter((rule) => Boolean(rule) && rule !== 'all')
        )
    );
    if (!normalizedRules.length) {
        return true;
    }

    const normalizedTitle = normalizeMarketText(trade.title);
    const normalizedSlug = normalizeMarketText(trade.slug);
    const normalizedEventSlug = normalizeMarketText(trade.eventSlug);

    return normalizedRules.some((rule) => {
        if (rule === 'crypto_updown_5m') {
            return isTradeWithinCryptoUpdownFiveMinuteScope(trade);
        }

        return (
            normalizedTitle.includes(rule) ||
            normalizedSlug.includes(rule) ||
            normalizedEventSlug.includes(rule)
        );
    });
};

export const isTradeWithinSignalMarketScope = (trade: {
    title?: string;
    slug?: string;
    eventSlug?: string;
}) => isTradeWithinMarketWhitelist(trade, ['crypto_updown_5m']);
