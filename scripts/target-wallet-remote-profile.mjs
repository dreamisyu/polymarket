import {
    buildTimeRange,
    countBy,
    formatPct,
    formatTimestamp,
    formatUsd,
    pct,
    quantile,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';
import { fetchPolymarketActivities, fetchPolymarketPositions } from './lib/polymarketApi.mjs';

const DEFAULT_TOP = 8;
const DEFAULT_WINDOWS_MS = [2000, 5000, 15000];

const parseArgs = (argv) => {
    const parsed = {
        userAddress: '',
        hours: 24,
        sinceTs: 0,
        untilTs: 0,
        windowsMs: DEFAULT_WINDOWS_MS,
        top: DEFAULT_TOP,
        withoutPositions: false,
        json: false,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];

        if (current === '--json') {
            parsed.json = true;
            continue;
        }

        if (current === '--without-positions') {
            parsed.withoutPositions = true;
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

        if (current === '--windows-ms' && argv[index + 1]) {
            parsed.windowsMs = String(argv[index + 1])
                .split(',')
                .map((item) => Math.max(Number.parseInt(item, 10) || 0, 0))
                .filter((item) => item > 0);
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

const argv = parseArgs(process.argv.slice(2));

if (argv.help || !argv.userAddress) {
    console.log(`用法:
  node scripts/target-wallet-remote-profile.mjs --user-address 0x... [--hours 24] [--windows-ms 2000,5000,15000] [--json]

说明:
  1. 直接调用 Polymarket 官方 activity / positions 接口，无需本地 Mongo 预先同步该地址
  2. 重点输出高频 BUY 碎单占比、相邻聚合机会、交易节奏和持仓集中度
  3. 适合给小资金跟单前做目标画像
`);
    process.exit(argv.help ? 0 : 1);
}

const normalizeType = (item) =>
    String(item?.type || '')
        .trim()
        .toUpperCase();
const normalizeSide = (item) =>
    String(item?.side || '')
        .trim()
        .toUpperCase();
const getTitleKey = (item) =>
    String(item?.title || item?.slug || item?.conditionId || item?.market || 'UNKNOWN').trim();
const getMarketKey = (item) =>
    String(item?.conditionId || item?.market || item?.slug || item?.asset || 'UNKNOWN').trim();
const getTradeUsdc = (item) => {
    const direct = toSafeNumber(item?.usdcSize, NaN);
    if (Number.isFinite(direct) && direct >= 0) {
        return direct;
    }

    const size = toSafeNumber(item?.size, NaN);
    const price = toSafeNumber(item?.price, NaN);
    if (Number.isFinite(size) && Number.isFinite(price)) {
        return size * price;
    }

    return 0;
};

const buildGapSummary = (activities) => {
    const buildGaps = (items) => {
        const ordered = [...items].sort((left, right) => left.timestamp - right.timestamp);
        const gaps = [];
        for (let index = 1; index < ordered.length; index += 1) {
            const gap =
                toSafeNumber(ordered[index]?.timestamp) -
                toSafeNumber(ordered[index - 1]?.timestamp);
            if (gap >= 0) {
                gaps.push(gap);
            }
        }
        return gaps;
    };

    const tradeItems = activities.filter((item) => normalizeType(item) === 'TRADE');
    const buyItems = tradeItems.filter((item) => normalizeSide(item) === 'BUY');
    const tradeGaps = buildGaps(tradeItems);
    const buyGaps = buildGaps(buyItems);

    return {
        tradeGapP50Ms: quantile(tradeGaps, 0.5),
        tradeGapP75Ms: quantile(tradeGaps, 0.75),
        buyGapP50Ms: quantile(buyGaps, 0.5),
        buyGapP75Ms: quantile(buyGaps, 0.75),
        buyGapP90Ms: quantile(buyGaps, 0.9),
    };
};

const buildBuySizeBands = (buyTrades) => {
    const bands = [
        { label: '<0.05u', max: 0.05 },
        { label: '<0.10u', max: 0.1 },
        { label: '<0.25u', max: 0.25 },
        { label: '<0.50u', max: 0.5 },
        { label: '<1.00u', max: 1 },
        { label: '1.00u-2.00u', min: 1, max: 2 },
        { label: '>=2.00u', min: 2 },
    ];

    return bands.map((band) => {
        const matched = buyTrades.filter((item) => {
            const usdc = getTradeUsdc(item);
            const meetsMin = band.min === undefined || usdc >= band.min;
            const meetsMax = band.max === undefined || usdc < band.max;
            return meetsMin && meetsMax;
        });

        return {
            ...band,
            count: matched.length,
            pct: pct(matched.length, buyTrades.length),
            totalUsdc: sumBy(matched, (item) => getTradeUsdc(item)),
        };
    });
};

const buildAdjacentBuyClusters = (buyTrades, windowMs, top) => {
    const orderedTrades = [...buyTrades].sort((left, right) => left.timestamp - right.timestamp);
    const clusters = [];

    for (const trade of orderedTrades) {
        const key = `${trade.conditionId || ''}:${trade.outcome || ''}:${trade.side || ''}`;
        const tradeUsdc = getTradeUsdc(trade);
        const timestamp = toSafeNumber(trade.timestamp);
        const lastCluster = clusters[clusters.length - 1];

        if (
            lastCluster &&
            lastCluster.key === key &&
            timestamp > 0 &&
            lastCluster.endedAt > 0 &&
            timestamp - lastCluster.endedAt <= windowMs
        ) {
            lastCluster.docs.push(trade);
            lastCluster.endedAt = timestamp;
            lastCluster.totalUsdc += tradeUsdc;
            continue;
        }

        clusters.push({
            key,
            conditionId: trade.conditionId || '',
            outcome: trade.outcome || '',
            title: trade.title || trade.slug || '',
            startedAt: timestamp,
            endedAt: timestamp,
            totalUsdc: tradeUsdc,
            docs: [trade],
        });
    }

    const multiDocClusters = clusters.filter((cluster) => cluster.docs.length > 1);
    const rescuedClusters = multiDocClusters.filter(
        (cluster) => cluster.totalUsdc >= 1 && cluster.docs.every((item) => getTradeUsdc(item) < 1)
    );
    const clusterUsdcValues = multiDocClusters.map((cluster) => cluster.totalUsdc);

    return {
        windowMs,
        inputDocs: orderedTrades.length,
        clusterCount: clusters.length,
        multiDocClusterCount: multiDocClusters.length,
        savedDocs: Math.max(orderedTrades.length - clusters.length, 0),
        rescuedClusterCount: rescuedClusters.length,
        rescuedDocs: sumBy(rescuedClusters, (cluster) => cluster.docs.length),
        rescuedUsdc: sumBy(rescuedClusters, (cluster) => cluster.totalUsdc),
        clusterUsdcP50: quantile(clusterUsdcValues, 0.5),
        clusterUsdcP75: quantile(clusterUsdcValues, 0.75),
        clusterUsdcP90: quantile(clusterUsdcValues, 0.9),
        topCandidates: multiDocClusters
            .sort((left, right) => right.totalUsdc - left.totalUsdc)
            .slice(0, top)
            .map((cluster) => ({
                title: cluster.title || cluster.conditionId,
                conditionId: cluster.conditionId,
                outcome: cluster.outcome,
                docCount: cluster.docs.length,
                totalUsdc: cluster.totalUsdc,
                startedAt: cluster.startedAt,
                endedAt: cluster.endedAt,
            })),
    };
};

const summarizeTopMarkets = (activities, top) =>
    takeTopEntries(
        activities.reduce((result, item) => {
            const key = getMarketKey(item);
            const current = result.get(key) || {
                key,
                title: getTitleKey(item),
                rawCount: 0,
                buyCount: 0,
                sellCount: 0,
                buyUsdc: 0,
                sellUsdc: 0,
            };
            current.rawCount += 1;
            if (normalizeType(item) === 'TRADE' && normalizeSide(item) === 'BUY') {
                current.buyCount += 1;
                current.buyUsdc += getTradeUsdc(item);
            }
            if (normalizeType(item) === 'TRADE' && normalizeSide(item) === 'SELL') {
                current.sellCount += 1;
                current.sellUsdc += getTradeUsdc(item);
            }
            result.set(key, current);
            return result;
        }, new Map()),
        top
    ).map(([, value]) => value);

const summarizePositions = (positions, top) => {
    const openPositions = positions.filter((position) => toSafeNumber(position?.size) > 0);
    const totalCurrentValue = sumBy(openPositions, (position) => position?.currentValue);

    return {
        openCount: openPositions.length,
        redeemableCount: openPositions.filter((position) => Boolean(position?.redeemable)).length,
        mergeableCount: openPositions.filter((position) => Boolean(position?.mergeable)).length,
        totalCurrentValue,
        topPositions: [...openPositions]
            .sort(
                (left, right) =>
                    toSafeNumber(right?.currentValue) - toSafeNumber(left?.currentValue)
            )
            .slice(0, top)
            .map((position) => ({
                title: position?.title || position?.slug || position?.conditionId || 'UNKNOWN',
                outcome: position?.outcome || '',
                currentValue: toSafeNumber(position?.currentValue),
                size: toSafeNumber(position?.size),
                redeemable: Boolean(position?.redeemable),
                mergeable: Boolean(position?.mergeable),
            })),
    };
};

const buildStrategyHints = ({ buyTrades, burstStats, gapSummary, positionSummary }) => {
    const hints = [];
    const buyCount = buyTrades.length;
    const subOneBuyPct = pct(buyTrades.filter((item) => getTradeUsdc(item) < 1).length, buyCount);
    const deepDustPct = pct(buyTrades.filter((item) => getTradeUsdc(item) < 0.1).length, buyCount);
    const largestBurst = [...burstStats].sort((left, right) => right.windowMs - left.windowMs)[0];

    if (subOneBuyPct >= 70) {
        hints.push(
            'BUY 碎单占比很高，不适合逐笔按比例跟；应改为按 condition/outcome 聚合信号后再决定是否入场。'
        );
    }

    if (deepDustPct >= 40) {
        hints.push(
            '大量 BUY 低于 0.1u，说明目标在做微调仓或分片成交；90u 跟单必须忽略最小碎片，只跟有效累计信号。'
        );
    }

    if (largestBurst && largestBurst.rescuedClusterCount > 0) {
        hints.push(
            `在 ${largestBurst.windowMs}ms 窗口内已存在可被聚合救回的 BUY cluster，适合用 ${Math.round(largestBurst.windowMs / 1000)}s 左右的延迟聚合，而不是逐笔追单。`
        );
    }

    if (gapSummary.buyGapP50Ms > 0 && gapSummary.buyGapP50Ms <= 15000) {
        hints.push(
            'BUY 中位间隔较短，目标节奏偏高频；实盘应以内存状态聚合，避免把每笔碎单都落库后再决策。'
        );
    }

    if (
        positionSummary &&
        (positionSummary.mergeableCount > 0 || positionSummary.redeemableCount > 0)
    ) {
        hints.push(
            '目标当前仍有 mergeable/redeemable 持仓，MERGE/REDEEM 不能被当成纯同步事件，否则收益会和 paper 长期偏离。'
        );
    }

    if (hints.length === 0) {
        hints.push('目标画像没有暴露单一极端特征，建议结合模拟盘做 90u 参数回放后再定最终门槛。');
    }

    return hints;
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

const renderSummary = (summary) => {
    const lines = [];
    lines.push('目标账户远程画像');
    lines.push(`- 账户: ${summary.input.userAddress}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- 聚合窗口: ${summary.input.windowsMs.join(', ')} ms`);

    lines.push('');
    lines.push('活动画像');
    lines.push(`- 活动数: ${summary.activities.totalActivities}`);
    lines.push(
        `- TRADE / BUY / SELL / MERGE / REDEEM: ${summary.activities.tradeCount} / ${summary.activities.buyCount} / ${summary.activities.sellCount} / ${summary.activities.mergeCount} / ${summary.activities.redeemCount}`
    );
    lines.push(`- BUY 总额: ${formatUsd(summary.activities.buyUsdcTotal)}`);
    lines.push(`- BUY 中 <1u 占比: ${formatPct(summary.activities.subOneBuyPct)}`);
    lines.push(`- BUY 中 <0.1u 占比: ${formatPct(summary.activities.subPointOneBuyPct)}`);
    lines.push(
        `- BUY usdc 分位: P25=${formatUsd(summary.activities.buyUsdcP25)} P50=${formatUsd(summary.activities.buyUsdcP50)} P75=${formatUsd(summary.activities.buyUsdcP75)} P90=${formatUsd(summary.activities.buyUsdcP90)}`
    );
    lines.push(
        `- BUY 间隔: P50=${(summary.cadence.buyGapP50Ms / 1000).toFixed(2)}s P75=${(summary.cadence.buyGapP75Ms / 1000).toFixed(2)}s P90=${(summary.cadence.buyGapP90Ms / 1000).toFixed(2)}s`
    );
    lines.push(
        ...renderTopItems(
            'BUY 金额分段',
            summary.activities.buySizeBands,
            (item) =>
                `${item.label}: ${item.count} 笔 (${formatPct(item.pct)}) | ${formatUsd(item.totalUsdc)}`
        )
    );
    lines.push(
        ...renderTopItems(
            '热点市场',
            summary.activities.topMarkets,
            (item) =>
                `${item.title}: raw=${item.rawCount} buy=${item.buyCount} sell=${item.sellCount} buyUsdc=${formatUsd(item.buyUsdc)}`
        )
    );

    lines.push('');
    lines.push('相邻 BUY 聚合机会');
    for (const stat of summary.burstStats) {
        lines.push(
            `- ${stat.windowMs}ms: docs=${stat.inputDocs} clusters=${stat.clusterCount} multi=${stat.multiDocClusterCount} rescued=${stat.rescuedClusterCount} rescuedUsdc=${formatUsd(stat.rescuedUsdc)} clusterP75=${formatUsd(stat.clusterUsdcP75)}`
        );
    }

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
                    `${item.title} | ${item.outcome} | value=${formatUsd(item.currentValue)} | size=${item.size.toFixed(4)}`
            )
        );
    } else if (summary.positionFetchError) {
        lines.push('');
        lines.push(`当前持仓: 获取失败，reason=${summary.positionFetchError}`);
    }

    lines.push('');
    lines.push('脚本提示');
    for (const hint of summary.strategyHints) {
        lines.push(`- ${hint}`);
    }

    return lines.join('\n');
};

const main = async () => {
    const range = buildTimeRange({
        hours: argv.hours,
        sinceTs: argv.sinceTs,
        untilTs: argv.untilTs,
    });
    const activitiesResponse = await fetchPolymarketActivities(argv.userAddress, {
        sinceTs: range.sinceTs,
        untilTs: range.untilTs,
        userAgent: 'polymarket-copytrading-bot/remote-target-profile',
    });
    if (!Array.isArray(activitiesResponse.activities)) {
        throw new Error(activitiesResponse.error || '获取目标活动失败');
    }

    const activities = activitiesResponse.activities;
    const tradeActivities = activities.filter((item) => normalizeType(item) === 'TRADE');
    const buyTrades = tradeActivities.filter((item) => normalizeSide(item) === 'BUY');
    const sellTrades = tradeActivities.filter((item) => normalizeSide(item) === 'SELL');
    const burstStats = argv.windowsMs.map((windowMs) =>
        buildAdjacentBuyClusters(buyTrades, windowMs, argv.top)
    );
    const gapSummary = buildGapSummary(activities);
    const positionsResponse = argv.withoutPositions
        ? { positions: null, error: '' }
        : await fetchPolymarketPositions(
              argv.userAddress,
              'polymarket-copytrading-bot/remote-target-profile'
          );
    const positionSummary =
        Array.isArray(positionsResponse.positions) && !positionsResponse.error
            ? summarizePositions(positionsResponse.positions, argv.top)
            : null;

    const summary = {
        generatedAt: new Date().toISOString(),
        input: {
            userAddress: argv.userAddress,
            range,
            rangeLabel: `${range.sinceTs ? formatTimestamp(range.sinceTs) : '-∞'} ~ ${
                range.untilTs ? formatTimestamp(range.untilTs) : '+∞'
            }`,
            windowsMs: argv.windowsMs,
        },
        activities: {
            totalActivities: activities.length,
            tradeCount: tradeActivities.length,
            buyCount: buyTrades.length,
            sellCount: sellTrades.length,
            mergeCount: activities.filter((item) => normalizeType(item) === 'MERGE').length,
            redeemCount: activities.filter((item) => normalizeType(item) === 'REDEEM').length,
            buyUsdcTotal: sumBy(buyTrades, (item) => getTradeUsdc(item)),
            sellUsdcTotal: sumBy(sellTrades, (item) => getTradeUsdc(item)),
            subOneBuyPct: pct(
                buyTrades.filter((item) => getTradeUsdc(item) < 1).length,
                buyTrades.length
            ),
            subPointOneBuyPct: pct(
                buyTrades.filter((item) => getTradeUsdc(item) < 0.1).length,
                buyTrades.length
            ),
            buyUsdcP25: quantile(
                buyTrades.map((item) => getTradeUsdc(item)),
                0.25
            ),
            buyUsdcP50: quantile(
                buyTrades.map((item) => getTradeUsdc(item)),
                0.5
            ),
            buyUsdcP75: quantile(
                buyTrades.map((item) => getTradeUsdc(item)),
                0.75
            ),
            buyUsdcP90: quantile(
                buyTrades.map((item) => getTradeUsdc(item)),
                0.9
            ),
            byType: takeTopEntries(
                countBy(activities, (item) => normalizeType(item)),
                argv.top
            ).map(([key, value]) => ({ key, value })),
            buySizeBands: buildBuySizeBands(buyTrades),
            topMarkets: summarizeTopMarkets(activities, argv.top),
        },
        cadence: gapSummary,
        burstStats,
        positions: positionSummary,
        positionFetchError: positionsResponse.error || '',
    };

    summary.strategyHints = buildStrategyHints({
        buyTrades,
        burstStats,
        gapSummary,
        positionSummary,
    });

    if (argv.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    console.log(renderSummary(summary));
};

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(`生成目标账户远程画像失败: ${error.message}`);
        process.exit(1);
    });
