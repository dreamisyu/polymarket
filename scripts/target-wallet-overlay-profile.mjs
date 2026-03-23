import {
    ENV_FILE_PATH,
    buildTimeRange,
    buildTimeRangeFilter,
    closeMongo,
    connectMongo,
    fetchCollectionDocs,
    formatPct,
    formatTimestamp,
    getUserActivityCollectionName,
    pushSuggestion,
    quantile,
    readEnv,
    requireEnvValue,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';

const DEFAULT_USER_ADDRESS = readEnv('USER_ADDRESS') || '';
const DEFAULT_MONGO_URI = readEnv('MONGO_URI') || '';
const DEFAULT_TOP = 8;

const parseClockMinutes = (hourRaw, minuteRaw, periodRaw) => {
    const hour = Number.parseInt(String(hourRaw || ''), 10);
    const minute = Number.parseInt(String(minuteRaw || ''), 10);
    const period = String(periodRaw || '')
        .trim()
        .toUpperCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
        return Number.NaN;
    }

    const normalizedHour = hour % 12;
    const offset = period === 'PM' ? 12 : 0;
    return normalizedHour + offset < 24 ? (normalizedHour + offset) * 60 + minute : Number.NaN;
};

const isFiveMinuteUpdownTitle = (title) => {
    const normalizedTitle = String(title || '')
        .trim()
        .toLowerCase();
    const match = normalizedTitle.match(
        /(\d{1,2}):(\d{2})(am|pm)-(\d{1,2}):(\d{2})(am|pm)\s+et$/
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

const isTradeWithinFiveMinuteCryptoScope = (trade) => {
    const normalizedSlug = String(trade?.slug || trade?.eventSlug || '')
        .trim()
        .toLowerCase();
    const normalizedTitle = String(trade?.title || '')
        .trim()
        .toLowerCase();
    const titleFallbackMatched =
        !normalizedSlug &&
        (normalizedTitle.includes('bitcoin up or down') ||
            normalizedTitle.includes('ethereum up or down')) &&
        isFiveMinuteUpdownTitle(normalizedTitle);

    return (
        normalizedSlug.includes('btc-updown-5m') ||
        normalizedSlug.includes('eth-updown-5m') ||
        titleFallbackMatched
    );
};

const normalizeOutcome = (value) =>
    String(value || '')
        .trim()
        .toLowerCase();

const parseArgs = (argv) => {
    const parsed = {
        userAddress: DEFAULT_USER_ADDRESS,
        mongoUri: DEFAULT_MONGO_URI,
        hours: 6,
        sinceTs: 0,
        untilTs: 0,
        top: DEFAULT_TOP,
        json: false,
        help: false,
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

        if ((current === '--user-address' || current === '-u') && argv[index + 1]) {
            parsed.userAddress = argv[index + 1];
            index += 1;
            continue;
        }

        if ((current === '--mongo-uri' || current === '-d') && argv[index + 1]) {
            parsed.mongoUri = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--hours' && argv[index + 1]) {
            parsed.hours = Math.max(Number(argv[index + 1]) || 0, 0);
            index += 1;
            continue;
        }

        if (current === '--since-ts' && argv[index + 1]) {
            parsed.sinceTs = Math.max(Number(argv[index + 1]) || 0, 0);
            index += 1;
            continue;
        }

        if (current === '--until-ts' && argv[index + 1]) {
            parsed.untilTs = Math.max(Number(argv[index + 1]) || 0, 0);
            index += 1;
            continue;
        }

        if (current === '--top' && argv[index + 1]) {
            parsed.top = Math.max(Number.parseInt(argv[index + 1], 10) || DEFAULT_TOP, 1);
            index += 1;
        }
    }

    return parsed;
};

const summarizeConditionBehaviors = (activities, top) => {
    const buyTrades = activities
        .filter(
            (item) =>
                String(item?.type || '').toUpperCase() === 'TRADE' &&
                String(item?.side || '').toUpperCase() === 'BUY' &&
                isTradeWithinFiveMinuteCryptoScope(item)
        )
        .sort((left, right) => toSafeNumber(left.timestamp) - toSafeNumber(right.timestamp));

    const groupedConditions = new Map();
    for (const trade of buyTrades) {
        const conditionId = String(trade.conditionId || '').trim();
        if (!conditionId) {
            continue;
        }

        if (!groupedConditions.has(conditionId)) {
            groupedConditions.set(conditionId, []);
        }

        groupedConditions.get(conditionId).push(trade);
    }

    const conditionSummaries = [];

    for (const [conditionId, trades] of groupedConditions.entries()) {
        const outcomes = new Map();
        for (const trade of trades) {
            const outcomeKey = normalizeOutcome(trade.outcome);
            if (!outcomes.has(outcomeKey)) {
                outcomes.set(outcomeKey, {
                    outcome: String(trade.outcome || '').trim(),
                    sourceUsdc: 0,
                    tradeCount: 0,
                    firstTimestamp: 0,
                    lastTimestamp: 0,
                });
            }

            const summary = outcomes.get(outcomeKey);
            const timestamp = toSafeNumber(trade.timestamp);
            summary.sourceUsdc += toSafeNumber(trade.usdcSize);
            summary.tradeCount += 1;
            summary.firstTimestamp =
                summary.firstTimestamp > 0
                    ? Math.min(summary.firstTimestamp, timestamp)
                    : timestamp;
            summary.lastTimestamp = Math.max(summary.lastTimestamp, timestamp);
        }

        const orderedOutcomes = [...outcomes.values()].sort(
            (left, right) => right.sourceUsdc - left.sourceUsdc
        );
        const leader = orderedOutcomes[0] || null;
        const follower = orderedOutcomes[1] || null;
        const totalSourceUsdc = sumBy(orderedOutcomes, (item) => item.sourceUsdc);
        const dualSide = orderedOutcomes.length >= 2 && Boolean(leader) && Boolean(follower);
        const leaderShare =
            totalSourceUsdc > 0 && leader ? leader.sourceUsdc / totalSourceUsdc : 0;
        const followerDelayMs =
            dualSide &&
            leader &&
            follower &&
            leader.firstTimestamp > 0 &&
            follower.firstTimestamp > 0
                ? Math.max(follower.firstTimestamp - leader.firstTimestamp, 0)
                : 0;

        conditionSummaries.push({
            conditionId,
            title: String(trades[0]?.title || trades[0]?.slug || conditionId).trim(),
            totalSourceUsdc,
            totalTradeCount: trades.length,
            outcomeCount: orderedOutcomes.length,
            leaderOutcome: leader?.outcome || '',
            leaderSourceUsdc: leader?.sourceUsdc || 0,
            leaderTradeCount: leader?.tradeCount || 0,
            followerOutcome: follower?.outcome || '',
            followerSourceUsdc: follower?.sourceUsdc || 0,
            followerTradeCount: follower?.tradeCount || 0,
            leaderShare,
            leaderEdgeUsdc: Math.max((leader?.sourceUsdc || 0) - (follower?.sourceUsdc || 0), 0),
            dualSide,
            followerDelayMs,
            startedAt: leader?.firstTimestamp || 0,
            endedAt: Math.max(...orderedOutcomes.map((item) => item.lastTimestamp)),
        });
    }

    const dualSideConditions = conditionSummaries.filter((item) => item.dualSide);
    const singleSideConditions = conditionSummaries.filter((item) => !item.dualSide);

    return {
        buyTradeCount: buyTrades.length,
        conditionCount: conditionSummaries.length,
        dualSideCount: dualSideConditions.length,
        singleSideCount: singleSideConditions.length,
        dualSidePct:
            conditionSummaries.length > 0
                ? (dualSideConditions.length / conditionSummaries.length) * 100
                : 0,
        leaderShareP25: quantile(
            dualSideConditions.map((item) => item.leaderShare * 100),
            0.25
        ),
        leaderShareP50: quantile(
            dualSideConditions.map((item) => item.leaderShare * 100),
            0.5
        ),
        leaderShareP75: quantile(
            dualSideConditions.map((item) => item.leaderShare * 100),
            0.75
        ),
        leaderEdgeUsdcP25: quantile(
            dualSideConditions.map((item) => item.leaderEdgeUsdc),
            0.25
        ),
        leaderEdgeUsdcP50: quantile(
            dualSideConditions.map((item) => item.leaderEdgeUsdc),
            0.5
        ),
        leaderEdgeUsdcP75: quantile(
            dualSideConditions.map((item) => item.leaderEdgeUsdc),
            0.75
        ),
        followerDelayMsP50: quantile(
            dualSideConditions.map((item) => item.followerDelayMs),
            0.5
        ),
        followerDelayMsP75: quantile(
            dualSideConditions.map((item) => item.followerDelayMs),
            0.75
        ),
        followerDelayMsP90: quantile(
            dualSideConditions.map((item) => item.followerDelayMs),
            0.9
        ),
        followerWithin5sPct:
            dualSideConditions.length > 0
                ? (dualSideConditions.filter((item) => item.followerDelayMs <= 5000).length /
                      dualSideConditions.length) *
                  100
                : 0,
        followerWithin15sPct:
            dualSideConditions.length > 0
                ? (dualSideConditions.filter((item) => item.followerDelayMs <= 15000).length /
                      dualSideConditions.length) *
                  100
                : 0,
        followerWithin30sPct:
            dualSideConditions.length > 0
                ? (dualSideConditions.filter((item) => item.followerDelayMs <= 30000).length /
                      dualSideConditions.length) *
                  100
                : 0,
        topDualSideConditions: dualSideConditions
            .sort((left, right) => right.totalSourceUsdc - left.totalSourceUsdc)
            .slice(0, top)
            .map((item) => ({
                title: item.title,
                conditionId: item.conditionId,
                totalSourceUsdc: item.totalSourceUsdc,
                totalTradeCount: item.totalTradeCount,
                leaderOutcome: item.leaderOutcome,
                leaderSourceUsdc: item.leaderSourceUsdc,
                followerOutcome: item.followerOutcome,
                followerSourceUsdc: item.followerSourceUsdc,
                leaderSharePct: item.leaderShare * 100,
                leaderEdgeUsdc: item.leaderEdgeUsdc,
                followerDelayMs: item.followerDelayMs,
                startedAt: item.startedAt,
                endedAt: item.endedAt,
            })),
        topLeaderOnlyConditions: singleSideConditions
            .sort((left, right) => right.totalSourceUsdc - left.totalSourceUsdc)
            .slice(0, top)
            .map((item) => ({
                title: item.title,
                conditionId: item.conditionId,
                totalSourceUsdc: item.totalSourceUsdc,
                totalTradeCount: item.totalTradeCount,
                leaderOutcome: item.leaderOutcome,
                leaderSourceUsdc: item.leaderSourceUsdc,
                leaderTradeCount: item.leaderTradeCount,
                startedAt: item.startedAt,
                endedAt: item.endedAt,
            })),
    };
};

const buildSuggestions = (summary) => {
    const suggestions = [];
    pushSuggestion(
        suggestions,
        summary.dualSidePct >= 50,
        '目标在当前窗口内大量 condition 存在双边买入，单纯 leader-only 跟单会明显偏离目标结构。'
    );
    pushSuggestion(
        suggestions,
        summary.dualSideCount > 0 && summary.followerWithin5sPct < 50,
        '超过一半的双边补仓不是在 5 秒内完成，当前 5 秒 overlay 窗口更像是在错过真实补边，而不是简单阈值过高。'
    );
    pushSuggestion(
        suggestions,
        summary.dualSideCount > 0 && summary.leaderShareP50 >= 60 && summary.leaderShareP50 <= 75,
        '目标的双边结构更接近“主方向 6~7 成 + 补边 3~4 成”，应优先复刻比例形状，而不是把反边做成全有全无的独立信号。'
    );
    return suggestions;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/target-wallet-overlay-profile.mjs --user-address 0x... [--hours 6] [--json]

说明:
  1. 基于 Mongo 中的目标账户活动，分析 BTC/ETH 5min up/down 的 condition 级双边行为。
  2. 重点输出双边条件占比、主副边资金比例、补边延迟分位数。
  3. 用于判断当前策略该继续调参数，还是需要把 overlay 触发模型改成更长记忆的 condition 状态机。
`);
    process.exit(0);
}

const main = async () => {
    const userAddress = requireEnvValue(argv.userAddress, '目标钱包地址');
    const mongoUri = requireEnvValue(argv.mongoUri, 'MONGO_URI');
    const range = buildTimeRange({
        hours: argv.hours,
        sinceTs: argv.sinceTs,
        untilTs: argv.untilTs,
    });

    await connectMongo(mongoUri);

    try {
        const collectionName = getUserActivityCollectionName(userAddress);
        const filter = {
            ...buildTimeRangeFilter('timestamp', range),
            type: { $in: ['TRADE'] },
            side: 'BUY',
        };
        const activities = await fetchCollectionDocs(collectionName, filter, {
            sort: { timestamp: 1, _id: 1 },
        });

        const summary = summarizeConditionBehaviors(activities, argv.top);
        const output = {
            generatedAt: new Date().toISOString(),
            input: {
                userAddress,
                hours: argv.hours,
                sinceTs: range.sinceTs,
                untilTs: range.untilTs,
                rangeLabel: `${formatTimestamp(range.sinceTs)} ~ ${formatTimestamp(range.untilTs)}`,
                mongoUriLoadedFrom: ENV_FILE_PATH,
            },
            overlayBehavior: summary,
            suggestions: buildSuggestions(summary),
        };

        if (argv.json) {
            console.log(JSON.stringify(output, null, 2));
            return;
        }

        console.log('目标账户双边 overlay 行为画像');
        console.log(`窗口: ${output.input.rangeLabel}`);
        console.log(`BUY 文档: ${summary.buyTradeCount}`);
        console.log(
            `condition 数: ${summary.conditionCount}，双边: ${summary.dualSideCount} (${formatPct(summary.dualSidePct)})，单边: ${summary.singleSideCount}`
        );
        console.log(
            `主方向占比 P25/P50/P75: ${formatPct(summary.leaderShareP25)} / ${formatPct(summary.leaderShareP50)} / ${formatPct(summary.leaderShareP75)}`
        );
        console.log(
            `净优势资金 P25/P50/P75: ${summary.leaderEdgeUsdcP25.toFixed(4)} / ${summary.leaderEdgeUsdcP50.toFixed(4)} / ${summary.leaderEdgeUsdcP75.toFixed(4)} USDC`
        );
        console.log(
            `补边延迟 P50/P75/P90: ${summary.followerDelayMsP50} / ${summary.followerDelayMsP75} / ${summary.followerDelayMsP90} ms`
        );
        console.log(
            `补边落在 5s/15s/30s 内占比: ${formatPct(summary.followerWithin5sPct)} / ${formatPct(summary.followerWithin15sPct)} / ${formatPct(summary.followerWithin30sPct)}`
        );
        console.log('');
        console.log('Top 双边 condition:');
        for (const item of summary.topDualSideConditions) {
            console.log(
                `- ${item.title}: ${item.leaderOutcome} ${item.leaderSourceUsdc.toFixed(4)} / ${item.followerOutcome} ${item.followerSourceUsdc.toFixed(4)} USDC, share=${formatPct(item.leaderSharePct)}, edge=${item.leaderEdgeUsdc.toFixed(4)} USDC, delay=${item.followerDelayMs}ms`
            );
        }
        console.log('');
        console.log('建议:');
        for (const suggestion of buildSuggestions(summary)) {
            console.log(`- ${suggestion}`);
        }
    } finally {
        await closeMongo();
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
