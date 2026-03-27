const parseClockMinutes = (hourText: string, minuteText: string, meridiemText: string) => {
    const hour = Number.parseInt(hourText, 10);
    const minute = Number.parseInt(minuteText, 10);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return Number.NaN;
    }

    const meridiem = String(meridiemText || '').trim().toLowerCase();
    let normalizedHour = hour % 12;
    if (meridiem === 'pm') {
        normalizedHour += 12;
    }

    return normalizedHour * 60 + minute;
};

const isFiveMinuteUpdownTitle = (normalizedTitle: string) => {
    const match = normalizedTitle.match(/(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)\s*et/i);
    if (!match) {
        return false;
    }

    const startMinutes = parseClockMinutes(match[1], match[2], match[3]);
    const endMinutes = parseClockMinutes(match[4], match[5], match[6]);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) {
        return false;
    }

    const diff = endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;
    return diff === 5;
};

export const isTradeWithinSignalMarketScope = (trade: { title?: string; slug?: string; eventSlug?: string }) => {
    const normalizedSlug = String(trade.slug || trade.eventSlug || '').trim().toLowerCase();
    const normalizedTitle = String(trade.title || '').trim().toLowerCase();
    const titleFallbackMatched =
        !normalizedSlug &&
        (normalizedTitle.includes('bitcoin up or down') ||
            normalizedTitle.includes('ethereum up or down') ||
            normalizedTitle.includes('solana up or down') ||
            normalizedTitle.includes('xrp up or down')) &&
        isFiveMinuteUpdownTitle(normalizedTitle);

    return normalizedSlug.includes('btc-updown-5m') || titleFallbackMatched;
};
