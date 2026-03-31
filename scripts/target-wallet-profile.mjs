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
    pct,
    pushSuggestion,
    quantile,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';
import { fetchPolymarketPositions } from './lib/polymarketApi.mjs';
import {
    formatRangeLabel,
    getScopedCollectionNames,
    resolveMongoUri,
    resolveScopeRuntime,
} from './lib/scopeRuntime.mjs';

const DEFAULT_TOP = 8;
const DEFAULT_MERGE_WINDOW_MS = 3000;

const parseArgs = (argv) => {
    const parsed = {
        scopeKey: '',
        sourceWallet: '',
        targetWallet: '',
        runMode: '',
        strategyKind: '',
        mongoUri: '',
        hours: 24,
        sinceTs: 0,
        untilTs: 0,
        mergeWindowMs: DEFAULT_MERGE_WINDOW_MS,
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

        if ((current === '--scope-key' || current === '-s') && argv[index + 1]) {
            parsed.scopeKey = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--source-wallet' && argv[index + 1]) {
            parsed.sourceWallet = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--target-wallet' && argv[index + 1]) {
            parsed.targetWallet = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--run-mode' && argv[index + 1]) {
            parsed.runMode = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--strategy-kind' && argv[index + 1]) {
            parsed.strategyKind = argv[index + 1];
            index += 1;
            continue;
        }

        if ((current === '--mongo-uri' || current === '-d') && argv[index + 1]) {
            parsed.mongoUri = argv[index + 1];
            index += 1;
            continue;
        }

        if (current === '--hours' && argv[index + 1]) {
            parsed.hours = Math.max(toSafeNumber(argv[index + 1]), 0);
            index += 1;
            continue;
        }

        if (current === '--since-ts' && argv[index + 1]) {
            parsed.sinceTs = Math.max(toSafeNumber(argv[index + 1]), 0);
            index += 1;
            continue;
        }

        if (current === '--until-ts' && argv[index + 1]) {
            parsed.untilTs = Math.max(toSafeNumber(argv[index + 1]), 0);
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
  node scripts/target-wallet-profile.mjs [--scope-key key] [--hours 24] [--merge-window-ms 3000] [--json]
  node scripts/target-wallet-profile.mjs --source-wallet 0x... --target-wallet 0x... --run-mode paper --strategy-kind fixed_amount

说明:
  1. 画像数据来源于 source_events_* 集合，适配 src 迁移后的新库结构。
  2. 默认会补充调用 Polymarket positions 接口，可通过 --without-positions 关闭。
`);
    process.exit(0);
}

const normalizeText = (value, fallback = '') => String(value || '').trim() || fallback;

const normalizeUpper = (value, fallback = 'UNKNOWN') =>
    normalizeText(value, fallback).toUpperCase();

const inferAction = (item) => {
    const action = normalizeText(item?.action, '').toLowerCase();
    if (action) {
        return action.toUpperCase();
    }

    const type = normalizeUpper(item?.type, 'UNKNOWN');
    if (type === 'TRADE') {
        const side = normalizeUpper(item?.side, 'UNKNOWN');
        if (side === 'BUY' || side === 'SELL') {
            return side;
        }
    }

    return type;
};

const isTradeBuy = (item) => {
    const action = inferAction(item);
    return action === 'BUY';
};

const isTradeSell = (item) => {
    const action = inferAction(item);
    return action === 'SELL';
};

const toTimestamp = (item) => toSafeNumber(item?.timestamp);

const buildAdjacentBuyClusters = (buyEvents, mergeWindowMs, top) => {
    const ordered = [...buyEvents]
        .filter((item) => toTimestamp(item) > 0)
        .sort((left, right) => toTimestamp(left) - toTimestamp(right));

    const clusters = [];

    for (const event of ordered) {
        const key = `${normalizeText(event?.conditionId, 'UNKNOWN')}|${normalizeText(event?.asset, 'UNKNOWN')}|${normalizeText(event?.outcome, String(toSafeNumber(event?.outcomeIndex)))}`;
        const timestamp = toTimestamp(event);
        const usdcSize = toSafeNumber(event?.usdcSize);
        const lastCluster = clusters[clusters.length - 1];

        if (
            lastCluster &&
            lastCluster.key === key &&
            timestamp - lastCluster.endedAt <= mergeWindowMs
        ) {
            lastCluster.docs.push(event);
            lastCluster.endedAt = timestamp;
            lastCluster.totalUsdc += usdcSize;
            continue;
        }

        clusters.push({
            key,
            conditionId: normalizeText(event?.conditionId, 'UNKNOWN'),
            title: normalizeText(event?.title, normalizeText(event?.slug, 'UNKNOWN')),
            asset: normalizeText(event?.asset, 'UNKNOWN'),
            outcome: normalizeText(event?.outcome, String(toSafeNumber(event?.outcomeIndex))),
            startedAt: timestamp,
            endedAt: timestamp,
            docs: [event],
            totalUsdc: usdcSize,
        });
    }

    const multiDocClusters = clusters.filter((cluster) => cluster.docs.length > 1);
    const rescuedClusters = multiDocClusters.filter(
        (cluster) =>
            cluster.totalUsdc >= 1 &&
            cluster.docs.every(
                (event) => toSafeNumber(event?.usdcSize) > 0 && toSafeNumber(event?.usdcSize) < 1
            )
    );

    return {
        inputCount: ordered.length,
        clusterCount: clusters.length,
        mergedSavings: Math.max(ordered.length - clusters.length, 0),
        multiDocClusterCount: multiDocClusters.length,
        rescuedClusterCount: rescuedClusters.length,
        rescuedUsdc: sumBy(rescuedClusters, (item) => item.totalUsdc),
        topCandidates: multiDocClusters
            .sort((left, right) => right.totalUsdc - left.totalUsdc)
            .slice(0, top)
            .map((cluster) => ({
                conditionId: cluster.conditionId,
                title: cluster.title,
                docCount: cluster.docs.length,
                totalUsdc: cluster.totalUsdc,
                startedAt: cluster.startedAt,
                endedAt: cluster.endedAt,
            })),
    };
};

const summarizePositions = (positions, top) => {
    const normalized = Array.isArray(positions)
        ? positions.map((position) => ({
              conditionId: normalizeText(position?.conditionId, ''),
              title: normalizeText(
                  position?.title,
                  normalizeText(position?.slug, normalizeText(position?.question, 'UNKNOWN'))
              ),
              outcome: normalizeText(position?.outcome, ''),
              size: toSafeNumber(position?.size),
              currentValue: toSafeNumber(
                  position?.currentValue,
                  toSafeNumber(position?.current_value)
              ),
              initialValue: toSafeNumber(
                  position?.initialValue,
                  toSafeNumber(position?.initial_value)
              ),
              redeemable: Boolean(position?.redeemable),
              mergeable: Boolean(position?.mergeable),
          }))
        : [];

    const open = normalized.filter((position) => position.size > 0);

    return {
        totalCount: normalized.length,
        openCount: open.length,
        redeemableCount: open.filter((position) => position.redeemable).length,
        mergeableCount: open.filter((position) => position.mergeable).length,
        totalCurrentValue: sumBy(open, (position) => position.currentValue),
        totalInitialValue: sumBy(open, (position) => position.initialValue),
        topPositions: [...open]
            .sort((left, right) => right.currentValue - left.currentValue)
            .slice(0, top)
            .map((position) => ({
                title: position.title,
                conditionId: position.conditionId,
                outcome: position.outcome,
                currentValue: position.currentValue,
                size: position.size,
                redeemable: position.redeemable,
                mergeable: position.mergeable,
            })),
    };
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

const renderText = (summary) => {
    const lines = [];
    lines.push('目标账户画像（新集合版）');
    lines.push(`- 目标地址: ${summary.input.targetWallet || '-'}`);
    lines.push(`- scopeKey: ${summary.input.scopeKey}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- env 路径: ${summary.input.envFilePath}`);
    lines.push(`- 相邻 BUY 合并窗口: ${summary.input.mergeWindowMs}ms`);

    lines.push('');
    lines.push('活动概览');
    lines.push(`- 活动总数: ${summary.activities.total}`);
    lines.push(
        `- TRADE BUY / SELL: ${summary.activities.buyCount} / ${summary.activities.sellCount}`
    );
    lines.push(`- MERGE + REDEEM: ${summary.activities.mergeRedeemCount}`);
    lines.push(`- BUY 中 <1u 占比: ${formatPct(summary.activities.smallBuyPct)}`);
    lines.push(`- pending+retry+processing 占比: ${formatPct(summary.activities.pendingRetryPct)}`);
    lines.push(
        `- BUY usdc 分位 P25/P50/P75: ${formatUsd(summary.activities.buyUsdcP25)} / ${formatUsd(summary.activities.buyUsdcP50)} / ${formatUsd(summary.activities.buyUsdcP75)}`
    );
    lines.push(`- 交易频率: ${summary.activities.tradesPerHour.toFixed(2)} 次/小时`);
    lines.push(`- BUY 相邻间隔 P50: ${(summary.activities.buyIntervalP50Ms / 1000).toFixed(2)} 秒`);
    lines.push(
        ...renderTopItems(
            '动作分布',
            summary.activities.actionCounts,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '活动状态分布',
            summary.activities.statusCounts,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '快照状态分布',
            summary.activities.snapshotCounts,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '热点市场（按成交额）',
            summary.activities.topConditionsByUsdc,
            (item) => `${item.title}: ${formatUsd(item.usdc)} (${item.count} 笔)`
        )
    );

    lines.push('');
    lines.push('相邻 BUY 聚类');
    lines.push(`- BUY 输入数: ${summary.adjacentBuy.inputCount}`);
    lines.push(`- 聚类后簇数: ${summary.adjacentBuy.clusterCount}`);
    lines.push(`- 可节省文档写入: ${summary.adjacentBuy.mergedSavings}`);
    lines.push(`- 多笔簇数量: ${summary.adjacentBuy.multiDocClusterCount}`);
    lines.push(
        `- 可跨 1u 门槛簇: ${summary.adjacentBuy.rescuedClusterCount}（${formatUsd(summary.adjacentBuy.rescuedUsdc)}）`
    );
    lines.push(
        ...renderTopItems(
            '候选簇 Top',
            summary.adjacentBuy.topCandidates,
            (item) =>
                `${item.title}: ${item.docCount} 笔, ${formatUsd(item.totalUsdc)} (${formatTimestamp(item.startedAt)} ~ ${formatTimestamp(item.endedAt)})`
        )
    );

    if (summary.positions) {
        lines.push('');
        lines.push('官方持仓补充');
        lines.push(
            `- open / redeemable / mergeable: ${summary.positions.openCount} / ${summary.positions.redeemableCount} / ${summary.positions.mergeableCount}`
        );
        lines.push(
            `- 当前价值 / 初始价值: ${formatUsd(summary.positions.totalCurrentValue)} / ${formatUsd(summary.positions.totalInitialValue)}`
        );
        lines.push(
            ...renderTopItems(
                '持仓 Top',
                summary.positions.topPositions,
                (item) =>
                    `${item.title} [${item.outcome}] ${formatUsd(item.currentValue)} size=${item.size.toFixed(6)} redeemable=${item.redeemable} mergeable=${item.mergeable}`
            )
        );
    }

    lines.push('');
    lines.push('建议');
    for (const suggestion of summary.suggestions) {
        lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
};

const run = async () => {
    const scope = resolveScopeRuntime({
        scopeKey: argv.scopeKey,
        sourceWallet: argv.sourceWallet,
        targetWallet: argv.targetWallet,
        runMode: argv.runMode,
        strategyKind: argv.strategyKind,
    });
    const collections = getScopedCollectionNames(scope.scopeKey);
    const mongoUri = resolveMongoUri(argv.mongoUri);
    const range = buildTimeRange({
        hours: argv.hours,
        sinceTs: argv.sinceTs,
        untilTs: argv.untilTs,
    });

    await connectMongo(mongoUri);

    try {
        const sourceEvents = await fetchCollectionDocs(
            collections.sourceEvents,
            buildTimeRangeFilter('timestamp', range),
            {
                sort: { timestamp: 1 },
                projection: {
                    timestamp: 1,
                    type: 1,
                    side: 1,
                    action: 1,
                    conditionId: 1,
                    asset: 1,
                    outcome: 1,
                    outcomeIndex: 1,
                    title: 1,
                    slug: 1,
                    usdcSize: 1,
                    size: 1,
                    status: 1,
                    executionIntent: 1,
                    snapshotStatus: 1,
                },
            }
        );

        const buyEvents = sourceEvents.filter((item) => isTradeBuy(item));
        const sellEvents = sourceEvents.filter((item) => isTradeSell(item));
        const mergeRedeemEvents = sourceEvents.filter((item) => {
            const action = inferAction(item);
            return action === 'MERGE' || action === 'REDEEM';
        });

        const pendingRetryEvents = sourceEvents.filter((item) => {
            const status = normalizeText(item?.status, 'pending').toLowerCase();
            return status === 'pending' || status === 'retry' || status === 'processing';
        });

        const buyUsdcSamples = buyEvents
            .map((item) => toSafeNumber(item?.usdcSize))
            .filter((value) => value > 0);
        const smallBuyEvents = buyEvents.filter((item) => {
            const usdc = toSafeNumber(item?.usdcSize);
            return usdc > 0 && usdc < 1;
        });

        const tradeEvents = sourceEvents.filter((item) => {
            const action = inferAction(item);
            return action === 'BUY' || action === 'SELL';
        });

        const eventTimestamps = tradeEvents.map(toTimestamp).filter((timestamp) => timestamp > 0);
        const timeSpanMs =
            eventTimestamps.length >= 2
                ? Math.max(eventTimestamps[eventTimestamps.length - 1] - eventTimestamps[0], 1)
                : 0;
        const tradesPerHour =
            timeSpanMs > 0 ? (tradeEvents.length * 3_600_000) / timeSpanMs : tradeEvents.length;

        const buyIntervals = [];
        for (let index = 1; index < buyEvents.length; index += 1) {
            const current = toTimestamp(buyEvents[index]);
            const previous = toTimestamp(buyEvents[index - 1]);
            if (current > previous && previous > 0) {
                buyIntervals.push(current - previous);
            }
        }

        const topConditionsByUsdc = (() => {
            const aggregates = new Map();
            for (const event of tradeEvents) {
                const conditionId = normalizeText(event?.conditionId, 'UNKNOWN');
                const title = normalizeText(event?.title, normalizeText(event?.slug, conditionId));
                const key = `${conditionId}::${title}`;
                const snapshot = aggregates.get(key) || {
                    conditionId,
                    title,
                    usdc: 0,
                    count: 0,
                };
                snapshot.usdc += toSafeNumber(event?.usdcSize);
                snapshot.count += 1;
                aggregates.set(key, snapshot);
            }

            return [...aggregates.values()]
                .sort((left, right) => {
                    if (right.usdc !== left.usdc) {
                        return right.usdc - left.usdc;
                    }

                    return right.count - left.count;
                })
                .slice(0, argv.top);
        })();

        const adjacentBuy = buildAdjacentBuyClusters(buyEvents, argv.mergeWindowMs, argv.top);

        let positions = null;
        let positionsError = '';
        if (argv.fetchPositions && scope.targetWallet) {
            const fetched = await fetchPolymarketPositions(
                scope.targetWallet,
                'polymarket-copytrading-bot/target-wallet-profile'
            );
            positionsError = normalizeText(fetched.error, '');
            positions = summarizePositions(fetched.positions || [], argv.top);
        }

        const summary = {
            input: {
                scopeKey: scope.scopeKey,
                scopeSource: scope.scopeSource,
                sourceWallet: scope.sourceWallet,
                targetWallet: scope.targetWallet,
                range,
                rangeLabel: formatRangeLabel(range),
                mergeWindowMs: argv.mergeWindowMs,
                envFilePath: ENV_FILE_PATH,
                mongoUriLoadedFrom: argv.mongoUri ? '--mongo-uri' : 'MONGO_URI',
            },
            collections,
            activities: {
                total: sourceEvents.length,
                tradeCount: tradeEvents.length,
                buyCount: buyEvents.length,
                sellCount: sellEvents.length,
                mergeRedeemCount: mergeRedeemEvents.length,
                smallBuyCount: smallBuyEvents.length,
                smallBuyPct: pct(smallBuyEvents.length, buyEvents.length),
                pendingRetryCount: pendingRetryEvents.length,
                pendingRetryPct: pct(pendingRetryEvents.length, sourceEvents.length),
                buyUsdcP25: quantile(buyUsdcSamples, 0.25),
                buyUsdcP50: quantile(buyUsdcSamples, 0.5),
                buyUsdcP75: quantile(buyUsdcSamples, 0.75),
                tradesPerHour,
                buyIntervalP50Ms: quantile(buyIntervals, 0.5),
                actionCounts: takeTopEntries(
                    countBy(sourceEvents, (item) => inferAction(item)),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                statusCounts: takeTopEntries(
                    countBy(sourceEvents, (item) => normalizeText(item?.status, 'pending')),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                snapshotCounts: takeTopEntries(
                    countBy(sourceEvents, (item) => normalizeText(item?.snapshotStatus, 'UNKNOWN')),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                topConditionsByUsdc,
            },
            adjacentBuy,
            positions,
            positionsError,
            suggestions: [],
        };

        pushSuggestion(
            summary.suggestions,
            summary.activities.smallBuyPct >= 30,
            '目标账户 BUY 小额碎单占比较高，建议继续前移相邻合并并配合最小下单策略。'
        );
        pushSuggestion(
            summary.suggestions,
            adjacentBuy.rescuedClusterCount > 0,
            '存在可聚合后跨过 1u 的 BUY 簇，说明监控入口仍有显著合并收益。'
        );
        pushSuggestion(
            summary.suggestions,
            summary.activities.pendingRetryPct >= 20,
            'source_events 中 pending/retry 占比偏高，建议排查执行吞吐和重试退避参数。'
        );

        const staleOrPartialCount =
            summary.activities.snapshotCounts.find((item) =>
                ['PARTIAL', 'STALE'].includes(item.key)
            )?.value || 0;
        pushSuggestion(
            summary.suggestions,
            pct(staleOrPartialCount, summary.activities.total) >= 10,
            '快照 PARTIAL/STALE 占比偏高，建议优先提高快照可用性与缓存命中率。'
        );

        pushSuggestion(
            summary.suggestions,
            summary.positions &&
                (summary.positions.redeemableCount > 0 || summary.positions.mergeableCount > 0),
            '目标账户当前存在 redeemable/mergeable 持仓，可纳入结算链路回归样本。'
        );

        if (summary.positionsError) {
            summary.suggestions.push(`持仓接口补充失败：${summary.positionsError}`);
        }

        if (summary.suggestions.length === 0) {
            summary.suggestions.push(
                '当前窗口画像较平稳，建议结合 DB 与日志报告继续观察连续时段变化。'
            );
        }

        if (argv.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        console.log(renderText(summary));
    } finally {
        await closeMongo();
    }
};

run().catch((error) => {
    console.error(`target-wallet-profile 执行失败: ${error?.message || error}`);
    process.exit(1);
});
