import {
    ENV_FILE_PATH,
    buildTimeRange,
    buildTimeRangeFilter,
    closeMongo,
    connectMongo,
    countBy,
    fetchCollectionDocs,
    formatPct,
    formatTimestamp,
    formatUsd,
    getUserActivityCollectionName,
    pct,
    pushSuggestion,
    quantile,
    readEnv,
    requireEnvValue,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';
import { fetchPolymarketPositions } from './lib/polymarketApi.mjs';

const DEFAULT_USER_ADDRESS = readEnv('USER_ADDRESS') || '';
const DEFAULT_MONGO_URI = readEnv('MONGO_URI') || '';
const DEFAULT_TOP = 8;

const parseArgs = (argv) => {
    const parsed = {
        userAddress: DEFAULT_USER_ADDRESS,
        mongoUri: DEFAULT_MONGO_URI,
        hours: 24,
        sinceTs: 0,
        untilTs: 0,
        mergeWindowMs: 15000,
        fetchPositions: true,
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

        if (current === '--merge-window-ms' && argv[index + 1]) {
            parsed.mergeWindowMs = Math.max(Number.parseInt(argv[index + 1], 10) || 0, 1);
            index += 1;
            continue;
        }

        if (current === '--without-positions') {
            parsed.fetchPositions = false;
            continue;
        }

        if (current === '--top' && argv[index + 1]) {
            parsed.top = Math.max(Number.parseInt(argv[index + 1], 10) || DEFAULT_TOP, 1);
            index += 1;
        }
    }

    return parsed;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/target-wallet-profile.mjs [--user-address 0x...] [--hours 24] [--merge-window-ms 15000] [--json]

说明:
  1. 基于 Mongo 中的目标账户活动，分析交易风格、小单占比、相邻合并机会和市场集中度
  2. 默认会额外拉取 Polymarket 官方持仓接口，补充当前 open/redeemable/mergeable 曝光
  3. 如仅需本地 DB 分析，可追加 --without-positions
`);
    process.exit(0);
}

const getSourceTradeCount = (item) => Math.max(toSafeNumber(item?.sourceTradeCount, 1), 1);

const getTitleKey = (item) =>
    String(item?.title || item?.slug || item?.conditionId || 'UNKNOWN').trim();

const buildAdjacentBuyClusters = (activities, mergeWindowMs, top) => {
    const orderedTrades = activities
        .filter(
            (item) =>
                String(item.type || '').toUpperCase() === 'TRADE' &&
                String(item.side || '').toUpperCase() === 'BUY'
        )
        .sort((left, right) => toSafeNumber(left.timestamp) - toSafeNumber(right.timestamp));

    const clusters = [];

    for (const trade of orderedTrades) {
        const lastCluster = clusters[clusters.length - 1];
        const timestamp = toSafeNumber(trade.timestamp);

        if (!lastCluster) {
            clusters.push({
                key: `${trade.conditionId || ''}:${trade.outcome || ''}:${trade.side || ''}`,
                conditionId: trade.conditionId || '',
                outcome: trade.outcome || '',
                side: trade.side || '',
                title: trade.title || '',
                startedAt: timestamp,
                endedAt: timestamp,
                docs: [trade],
                totalUsdc: toSafeNumber(trade.usdcSize),
            });
            continue;
        }

        const nextKey = `${trade.conditionId || ''}:${trade.outcome || ''}:${trade.side || ''}`;
        const canMerge =
            lastCluster.key === nextKey &&
            timestamp > 0 &&
            lastCluster.endedAt > 0 &&
            timestamp - lastCluster.endedAt <= mergeWindowMs;

        if (canMerge) {
            lastCluster.docs.push(trade);
            lastCluster.endedAt = timestamp;
            lastCluster.totalUsdc += toSafeNumber(trade.usdcSize);
            continue;
        }

        clusters.push({
            key: nextKey,
            conditionId: trade.conditionId || '',
            outcome: trade.outcome || '',
            side: trade.side || '',
            title: trade.title || '',
            startedAt: timestamp,
            endedAt: timestamp,
            docs: [trade],
            totalUsdc: toSafeNumber(trade.usdcSize),
        });
    }

    const multiDocClusters = clusters.filter((cluster) => cluster.docs.length > 1);
    const rescuedClusters = multiDocClusters.filter(
        (cluster) =>
            cluster.totalUsdc >= 1 && cluster.docs.every((item) => toSafeNumber(item.usdcSize) < 1)
    );

    return {
        inputDocs: orderedTrades.length,
        clusterCount: clusters.length,
        savedDocs: Math.max(orderedTrades.length - clusters.length, 0),
        multiDocClusterCount: multiDocClusters.length,
        rescuedClusterCount: rescuedClusters.length,
        rescuedUsdc: sumBy(rescuedClusters, (cluster) => cluster.totalUsdc),
        topCandidates: multiDocClusters
            .sort((left, right) => right.totalUsdc - left.totalUsdc)
            .slice(0, top)
            .map((cluster) => ({
                title: cluster.title,
                conditionId: cluster.conditionId,
                outcome: cluster.outcome,
                docCount: cluster.docs.length,
                totalUsdc: cluster.totalUsdc,
                startedAt: cluster.startedAt,
                endedAt: cluster.endedAt,
            })),
    };
};

const summarizePositions = (positions, top) => {
    const openPositions = positions.filter((position) => toSafeNumber(position.size) > 0);
    const topPositions = [...openPositions]
        .sort((left, right) => toSafeNumber(right.currentValue) - toSafeNumber(left.currentValue))
        .slice(0, top)
        .map((position) => ({
            title: position.title || position.slug || position.conditionId || 'UNKNOWN',
            outcome: position.outcome || '',
            currentValue: toSafeNumber(position.currentValue),
            size: toSafeNumber(position.size),
            redeemable: Boolean(position.redeemable),
            mergeable: Boolean(position.mergeable),
        }));

    return {
        openCount: openPositions.length,
        redeemableCount: openPositions.filter((position) => Boolean(position.redeemable)).length,
        mergeableCount: openPositions.filter((position) => Boolean(position.mergeable)).length,
        totalCurrentValue: sumBy(openPositions, (position) => position.currentValue),
        totalInitialValue: sumBy(openPositions, (position) => position.initialValue),
        topPositions,
    };
};

const buildSuggestions = ({ activitySummary, adjacentBuyClusters, positionSummary }) => {
    const suggestions = [];

    pushSuggestion(
        suggestions,
        pct(activitySummary.smallBuyDocs, activitySummary.buyTrades) >= 25,
        '目标账户 BUY 中小额碎单占比偏高，跟单改进应优先围绕监视器合并和最小下单策略展开。'
    );
    pushSuggestion(
        suggestions,
        adjacentBuyClusters.rescuedClusterCount > 0,
        '按当前脚本窗口模拟，已有相邻 BUY 可以被合并后跨过 1u 门槛，说明监视器仍有继续前移聚合的空间。'
    );
    pushSuggestion(
        suggestions,
        pct(activitySummary.mergeRedeemActivities, activitySummary.totalActivities) >= 10,
        '目标账户 MERGE/REDEEM 占比较高，结算 worker 与 condition 净额模型仍应保持优先级。'
    );

    if (positionSummary) {
        pushSuggestion(
            suggestions,
            positionSummary.redeemableCount > 0 || positionSummary.mergeableCount > 0,
            '目标账户当前仍有 redeemable/mergeable 持仓，建议把这些 condition 加入常驻监控样本，持续验证结算回收链路。'
        );
        pushSuggestion(
            suggestions,
            pct(positionSummary.topPositions[0]?.currentValue, positionSummary.totalCurrentValue) >=
                30,
            '当前持仓价值集中在少数市场，建议增加按市场类型拆分的执行统计，避免高频市场掩盖大额市场的真实效果。'
        );
    }

    if (suggestions.length === 0) {
        suggestions.push(
            '目标账户画像暂未暴露新的单点问题，建议结合 DB 漏斗与日志脚本一起看，确认瓶颈位于入口、执行还是结算。'
        );
    }

    return suggestions;
};

const renderTopItems = (title, items, formatter) => {
    const lines = [`- ${title}:`];
    if (!Array.isArray(items) || items.length === 0) {
        lines.push('  - 无');
        return lines;
    }

    for (const item of items) {
        lines.push(`  - ${formatter(item)}`);
    }

    return lines;
};

const renderTextSummary = (summary) => {
    const lines = [];
    lines.push('目标账户画像');
    lines.push(`- 账户: ${summary.input.userAddress}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- Mongo 配置来源: ${summary.input.mongoUriLoadedFrom}`);
    lines.push(`- 相邻 BUY 分析窗口: ${summary.input.mergeWindowMs}ms`);

    lines.push('');
    lines.push('活动画像');
    lines.push(`- 活动文档数: ${summary.activities.totalActivities}`);
    lines.push(`- 折算原始交易数: ${summary.activities.totalRawTrades}`);
    lines.push(
        `- TRADE / BUY / SELL: ${summary.activities.tradeActivities} / ${summary.activities.buyTrades} / ${summary.activities.sellTrades}`
    );
    lines.push(`- BUY 中 <1u 占比: ${formatPct(summary.activities.smallBuyDocPct)}`);
    lines.push(`- MERGE + REDEEM 占比: ${formatPct(summary.activities.mergeRedeemPct)}`);
    lines.push(
        `- BUY usdc 分位: P25=${formatUsd(summary.activities.buyUsdcP25)} P50=${formatUsd(summary.activities.buyUsdcP50)} P75=${formatUsd(summary.activities.buyUsdcP75)}`
    );
    lines.push(
        ...renderTopItems(
            '活动类型',
            summary.activities.byType,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '热点市场',
            summary.activities.topTitles,
            (item) => `${item.title}: ${item.rawTradeCount}`
        )
    );

    lines.push('');
    lines.push('相邻 BUY 合并机会');
    lines.push(`- 输入 BUY 文档数: ${summary.adjacentBuyClusters.inputDocs}`);
    lines.push(`- 合并后 cluster 数: ${summary.adjacentBuyClusters.clusterCount}`);
    lines.push(`- 可减少文档数: ${summary.adjacentBuyClusters.savedDocs}`);
    lines.push(
        `- 可被 1u 门槛“救回”的 cluster 数: ${summary.adjacentBuyClusters.rescuedClusterCount}`
    );
    lines.push(`- 可救回名义 USDC: ${formatUsd(summary.adjacentBuyClusters.rescuedUsdc)}`);
    lines.push(
        ...renderTopItems(
            '主要合并候选',
            summary.adjacentBuyClusters.topCandidates,
            (item) =>
                `${item.title || item.conditionId} | ${item.outcome} | docs=${item.docCount} | usdc=${formatUsd(item.totalUsdc)} | ${formatTimestamp(item.startedAt)} ~ ${formatTimestamp(item.endedAt)}`
        )
    );

    if (summary.positions) {
        lines.push('');
        lines.push('当前持仓');
        lines.push(`- openCount: ${summary.positions.openCount}`);
        lines.push(`- redeemableCount: ${summary.positions.redeemableCount}`);
        lines.push(`- mergeableCount: ${summary.positions.mergeableCount}`);
        lines.push(`- totalCurrentValue: ${formatUsd(summary.positions.totalCurrentValue)}`);
        lines.push(
            ...renderTopItems(
                '持仓集中度',
                summary.positions.topPositions,
                (item) =>
                    `${item.title} | ${item.outcome} | value=${formatUsd(item.currentValue)} | size=${toSafeNumber(item.size).toFixed(4)}`
            )
        );
    } else if (summary.positionFetchError) {
        lines.push('');
        lines.push(`当前持仓: 获取失败，reason=${summary.positionFetchError}`);
    }

    lines.push('');
    lines.push('建议');
    for (const suggestion of summary.suggestions) {
        lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
};

const main = async () => {
    const userAddress = requireEnvValue(argv.userAddress, 'USER_ADDRESS');
    const mongoUri = requireEnvValue(argv.mongoUri, 'MONGO_URI');
    const range = buildTimeRange({
        hours: argv.hours,
        sinceTs: argv.sinceTs,
        untilTs: argv.untilTs,
    });

    await connectMongo(mongoUri);

    try {
        const activities = await fetchCollectionDocs(
            getUserActivityCollectionName(userAddress),
            buildTimeRangeFilter('timestamp', range),
            { sort: { timestamp: 1 } }
        );

        const tradeActivities = activities.filter(
            (item) => String(item.type || '').toUpperCase() === 'TRADE'
        );
        const buyTrades = tradeActivities.filter(
            (item) => String(item.side || '').toUpperCase() === 'BUY'
        );
        const smallBuyDocs = buyTrades.filter((item) => toSafeNumber(item.usdcSize) < 1).length;
        const mergeRedeemActivities = activities.filter((item) =>
            ['MERGE', 'REDEEM'].includes(String(item.type || '').toUpperCase())
        ).length;
        const positionsResponse = argv.fetchPositions
            ? await fetchPolymarketPositions(
                  userAddress,
                  'polymarket-copytrading-bot/target-profile'
              )
            : { positions: null, error: '', walletAddress: userAddress };

        const activitySummary = {
            totalActivities: activities.length,
            totalRawTrades: sumBy(activities, (item) => getSourceTradeCount(item)),
            tradeActivities: tradeActivities.length,
            buyTrades: buyTrades.length,
            sellTrades: tradeActivities.filter(
                (item) => String(item.side || '').toUpperCase() === 'SELL'
            ).length,
            mergeRedeemActivities,
            mergeRedeemPct: pct(mergeRedeemActivities, activities.length),
            smallBuyDocs,
            smallBuyDocPct: pct(smallBuyDocs, buyTrades.length),
            buyUsdcP25: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.25
            ),
            buyUsdcP50: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.5
            ),
            buyUsdcP75: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.75
            ),
            byType: takeTopEntries(
                countBy(activities, (item) => item.type || 'UNKNOWN'),
                argv.top
            ).map(([key, value]) => ({ key, value })),
            topTitles: takeTopEntries(
                activities.reduce((result, item) => {
                    const key = getTitleKey(item);
                    result.set(key, (result.get(key) || 0) + getSourceTradeCount(item));
                    return result;
                }, new Map()),
                argv.top
            ).map(([title, rawTradeCount]) => ({ title, rawTradeCount })),
        };

        const adjacentBuyClusters = buildAdjacentBuyClusters(
            activities,
            argv.mergeWindowMs,
            argv.top
        );
        const positionSummary =
            Array.isArray(positionsResponse.positions) && !positionsResponse.error
                ? summarizePositions(positionsResponse.positions, argv.top)
                : null;

        const summary = {
            generatedAt: new Date().toISOString(),
            input: {
                userAddress,
                mergeWindowMs: argv.mergeWindowMs,
                range,
                rangeLabel: `${range.sinceTs ? formatTimestamp(range.sinceTs) : '-∞'} ~ ${
                    range.untilTs ? formatTimestamp(range.untilTs) : '+∞'
                }`,
                mongoUriLoadedFrom: ENV_FILE_PATH,
            },
            activities: activitySummary,
            adjacentBuyClusters,
            positions: positionSummary,
            positionFetchError: positionsResponse.error || '',
        };

        summary.suggestions = buildSuggestions({
            activitySummary,
            adjacentBuyClusters,
            positionSummary,
        });

        if (argv.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        console.log(renderTextSummary(summary));
    } finally {
        await closeMongo();
    }
};

main().catch(async (error) => {
    console.error(`生成目标账户画像失败: ${error.message}`);
    await closeMongo();
    process.exit(1);
});
