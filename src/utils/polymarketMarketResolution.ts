import fetchData from './fetchData';

const NEW_YORK_TIME_ZONE = 'America/New_York';
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

export interface PolymarketMarketResolution {
    marketSlug: string;
    marketUrl: string;
    resolvedStatus: string;
    winnerOutcome: string;
    title: string;
    updateDescription: string;
}

const decodeHtmlEntities = (value: string) =>
    String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

const extractMetaContent = (html: string, key: string) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`<meta[^>]+property="${escaped}"[^>]+content="([^"]*)"`, 'i'),
        new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escaped}"`, 'i'),
        new RegExp(`<meta[^>]+name="${escaped}"[^>]+content="([^"]*)"`, 'i'),
        new RegExp(`<meta[^>]+content="([^"]*)"[^>]+name="${escaped}"`, 'i'),
    ];

    for (const pattern of patterns) {
        const matched = html.match(pattern);
        if (matched?.[1]) {
            return decodeHtmlEntities(matched[1]);
        }
    }

    return '';
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

export const isResolvedPolymarketMarket = (resolution: PolymarketMarketResolution | null) =>
    String(resolution?.resolvedStatus || '').toLowerCase() === 'resolved' &&
    normalizeOutcomeLabel(resolution?.winnerOutcome || '') !== '';

export const fetchPolymarketMarketResolution = async (
    marketSlug: string
): Promise<PolymarketMarketResolution | null> => {
    const normalizedMarketSlug = String(marketSlug || '').trim();
    if (!normalizedMarketSlug) {
        return null;
    }

    const marketUrl = `https://polymarket.com/event/${normalizedMarketSlug}/${normalizedMarketSlug}`;
    const html = await fetchData<string>(marketUrl);
    if (typeof html !== 'string' || !html.trim()) {
        return null;
    }

    const resolvedStatus = extractMetaContent(html, 'og:temporal:status');
    const updateDescription = extractMetaContent(html, 'og:temporal:event_update:description');
    const title = extractMetaContent(html, 'og:title') || extractMetaContent(html, 'og:image:alt');
    const winnerMatch = updateDescription.match(/The winning outcome is ([A-Za-z]+)/i);

    return {
        marketSlug: normalizedMarketSlug,
        marketUrl,
        resolvedStatus,
        winnerOutcome: winnerMatch?.[1] || '',
        title,
        updateDescription,
    };
};
