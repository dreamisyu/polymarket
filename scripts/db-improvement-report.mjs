import {
    ENV_FILE_PATH,
    buildTimeRange,
    buildTimeRangeFilter,
    closeMongo,
    connectMongo,
    countBy,
    fetchCollectionDocs,
    fetchSingleDoc,
    formatCount,
    formatPct,
    formatTimestamp,
    formatUsd,
    getCollectionIfExists,
    pct,
    pushSuggestion,
    quantile,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';
import {
    buildDateRangeFilter,
    formatRangeLabel,
    getScopedCollectionNames,
    resolveMongoUri,
    resolveScopeRuntime,
} from './lib/scopeRuntime.mjs';

const DEFAULT_TOP = 8;
const SOURCE_QUEUE_STATUSES = new Set(['pending', 'processing', 'retry']);
const SOURCE_TERMINAL_STATUSES = new Set(['confirmed', 'skipped', 'failed']);

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
  node scripts/db-improvement-report.mjs [--scope-key key] [--hours 24] [--top 8] [--json]
  node scripts/db-improvement-report.mjs --source-wallet 0x... --target-wallet 0x... --run-mode paper --strategy-kind signal

说明:
  1. 基于新仓库结构读取 source_events / executions / settlement_tasks / positions / portfolios。
  2. 默认统计最近 24 小时数据，可通过 --hours / --since-ts / --until-ts 覆盖。
  3. scope 优先级：--scope-key > SCOPE_KEY > SOURCE_WALLET+TARGET_WALLET+RUN_MODE+STRATEGY_KIND。
`);
    process.exit(0);
}

const normalizeText = (value, fallback = 'UNKNOWN') => String(value || '').trim() || fallback;

const buildTopReasonItems = (items, valueGetter, top) => {
    const counts = new Map();
    for (const item of items) {
        const reason = normalizeText(valueGetter(item), 'UNKNOWN');
        if (reason === 'UNKNOWN') {
            continue;
        }

        counts.set(reason, (counts.get(reason) || 0) + 1);
    }

    return takeTopEntries(counts, top).map(([reason, count]) => ({ reason, count }));
};

const buildTopConditionItems = (items, top) => {
    const counts = new Map();
    for (const item of items) {
        const conditionId = normalizeText(item?.conditionId, 'UNKNOWN');
        if (conditionId === 'UNKNOWN') {
            continue;
        }

        const snapshot = counts.get(conditionId) || { count: 0, usdc: 0 };
        snapshot.count += 1;
        snapshot.usdc += toSafeNumber(item?.usdcSize);
        counts.set(conditionId, snapshot);
    }

    return [...counts.entries()]
        .sort((left, right) => {
            if (right[1].count !== left[1].count) {
                return right[1].count - left[1].count;
            }

            return right[1].usdc - left[1].usdc;
        })
        .slice(0, top)
        .map(([conditionId, value]) => ({
            conditionId,
            count: value.count,
            usdc: value.usdc,
        }));
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

const serializeIndexKey = (keySpec) =>
    Object.entries(keySpec || {})
        .map(([key, value]) => `${key}:${value}`)
        .join(',');

const checkExpectedIndexes = (indexes, expected) => {
    const missing = [];

    for (const item of expected) {
        const expectedSignature = serializeIndexKey(item.key);
        const matched = indexes.some((index) => {
            const sameKey = serializeIndexKey(index.key) === expectedSignature;
            if (!sameKey) {
                return false;
            }

            if (item.unique === undefined) {
                return true;
            }

            return Boolean(index.unique) === Boolean(item.unique);
        });

        if (!matched) {
            missing.push(item.label);
        }
    }

    return missing;
};

const formatLatencyMinutes = (minutes) => {
    if (minutes <= 0) {
        return '-';
    }

    return `${minutes.toFixed(1)} 分钟`;
};

const renderSummaryText = (summary) => {
    const lines = [];

    lines.push('DB 改进报告（新集合版）');
    lines.push(`- scopeKey: ${summary.input.scopeKey}`);
    lines.push(`- scope 来源: ${summary.input.scopeSource}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- env 路径: ${summary.input.envFilePath}`);

    lines.push('');
    lines.push('入口队列');
    lines.push(`- source_events 文档: ${formatCount(summary.source.total)}`);
    lines.push(`- 队列积压(pending+processing+retry): ${formatCount(summary.source.queueCount)} (${formatPct(summary.source.queuePct)})`);
    lines.push(`- 队列年龄 P50 / P90: ${formatLatencyMinutes(summary.source.queueAgeP50Minutes)} / ${formatLatencyMinutes(summary.source.queueAgeP90Minutes)}`);
    lines.push(`- EXECUTE 终态无 execution 记录: ${formatCount(summary.source.terminalWithoutExecutionCount)}`);
    lines.push(...renderTopItems('Source 状态分布', summary.source.statusCounts, (item) => `${item.key}: ${item.value}`));
    lines.push(...renderTopItems('Source 失败原因', summary.source.topErrors, (item) => `${item.reason}: ${item.count}`));
    lines.push(...renderTopItems('队列热点条件', summary.source.queueTopConditions, (item) => `${item.conditionId}: ${item.count} 条，${formatUsd(item.usdc)}`));

    lines.push('');
    lines.push('执行漏斗');
    lines.push(`- executions 文档: ${formatCount(summary.execution.total)}`);
    lines.push(`- 请求 / 实际成交: ${formatUsd(summary.execution.requestedUsdc)} / ${formatUsd(summary.execution.executedUsdc)}`);
    lines.push(`- 成交兑现率: ${formatPct(summary.execution.fulfillmentPct)}`);
    lines.push(`- 失败+重试占比: ${formatPct(summary.execution.failRetryPct)}`);
    lines.push(...renderTopItems('Execution 状态分布', summary.execution.statusCounts, (item) => `${item.key}: ${item.value}`));
    lines.push(...renderTopItems('Execution 原因 Top', summary.execution.topReasons, (item) => `${item.reason}: ${item.count}`));
    lines.push(...renderTopItems('策略轨迹 Top', summary.execution.policyTrailCounts, (item) => `${item.key}: ${item.value}`));

    lines.push('');
    lines.push('结算与持仓');
    lines.push(`- settlement_tasks 文档: ${formatCount(summary.settlement.total)}`);
    lines.push(`- 到期未处理任务: ${formatCount(summary.settlement.overdueCount)}`);
    lines.push(`- 平均重试次数: ${summary.settlement.avgRetryCount.toFixed(2)}`);
    lines.push(`- 当前 open positions: ${formatCount(summary.positions.openCount)}（redeemable: ${formatCount(summary.positions.redeemableCount)}）`);
    lines.push(`- 最新组合权益 / 现金: ${formatUsd(summary.portfolio.totalEquity)} / ${formatUsd(summary.portfolio.cashBalance)}`);
    lines.push(...renderTopItems('Settlement 状态分布', summary.settlement.statusCounts, (item) => `${item.key}: ${item.value}`));
    lines.push(...renderTopItems('Settlement 原因 Top', summary.settlement.topReasons, (item) => `${item.reason}: ${item.count}`));

    lines.push('');
    lines.push('索引检查');
    lines.push(`- source_events 缺失索引: ${summary.indexHealth.sourceMissing.length > 0 ? summary.indexHealth.sourceMissing.join('；') : '无'}`);
    lines.push(`- executions 缺失索引: ${summary.indexHealth.executionMissing.length > 0 ? summary.indexHealth.executionMissing.join('；') : '无'}`);
    lines.push(`- settlement_tasks 缺失索引: ${summary.indexHealth.settlementMissing.length > 0 ? summary.indexHealth.settlementMissing.join('；') : '无'}`);

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
        const sourceFilter = buildTimeRangeFilter('timestamp', range);
        const executionFilter = buildDateRangeFilter('createdAt', range);
        const settlementFilter = buildDateRangeFilter('updatedAt', range);

        const [
            sourceEvents,
            executions,
            settlementTasks,
            positions,
            portfolio,
            sourceIndexDocs,
            executionIndexDocs,
            settlementIndexDocs,
        ] = await Promise.all([
            fetchCollectionDocs(collections.sourceEvents, sourceFilter, {
                projection: {
                    timestamp: 1,
                    status: 1,
                    executionIntent: 1,
                    conditionId: 1,
                    usdcSize: 1,
                    snapshotStatus: 1,
                    attemptCount: 1,
                    lastError: 1,
                    nextRetryAt: 1,
                },
            }),
            fetchCollectionDocs(collections.executions, executionFilter, {
                projection: {
                    sourceEventId: 1,
                    status: 1,
                    action: 1,
                    conditionId: 1,
                    requestedUsdc: 1,
                    executedUsdc: 1,
                    reason: 1,
                    policyTrail: 1,
                },
            }),
            fetchCollectionDocs(collections.settlementTasks, settlementFilter, {
                projection: {
                    conditionId: 1,
                    status: 1,
                    retryCount: 1,
                    reason: 1,
                    nextRetryAt: 1,
                    winnerOutcome: 1,
                },
            }),
            fetchCollectionDocs(collections.positions, {}, {
                projection: {
                    asset: 1,
                    conditionId: 1,
                    size: 1,
                    marketValue: 1,
                    costBasis: 1,
                    redeemable: 1,
                    lastUpdatedAt: 1,
                },
            }),
            fetchSingleDoc(collections.portfolios, {}, {
                sort: { updatedAt: -1 },
                projection: {
                    cashBalance: 1,
                    totalEquity: 1,
                    activeExposureUsdc: 1,
                    openPositionCount: 1,
                    positionsMarketValue: 1,
                    realizedPnl: 1,
                },
            }),
            (async () => {
                const collection = await getCollectionIfExists(collections.sourceEvents);
                return collection ? collection.indexes() : [];
            })(),
            (async () => {
                const collection = await getCollectionIfExists(collections.executions);
                return collection ? collection.indexes() : [];
            })(),
            (async () => {
                const collection = await getCollectionIfExists(collections.settlementTasks);
                return collection ? collection.indexes() : [];
            })(),
        ]);

        const now = Date.now();

        const sourceStatusMap = countBy(sourceEvents, (item) => normalizeText(item?.status, 'pending'));
        const sourceQueueEvents = sourceEvents.filter((item) =>
            SOURCE_QUEUE_STATUSES.has(normalizeText(item?.status, 'pending').toLowerCase())
        );
        const sourceQueueAgesMinutes = sourceQueueEvents
            .map((item) => (now - toSafeNumber(item?.timestamp)) / 60_000)
            .filter((value) => Number.isFinite(value) && value > 0);

        const executionBySourceEventId = new Set(
            executions
                .map((item) => normalizeText(item?.sourceEventId, ''))
                .filter(Boolean)
        );

        const terminalExecuteWithoutExecution = sourceEvents.filter((item) => {
            const status = normalizeText(item?.status, 'pending').toLowerCase();
            if (!SOURCE_TERMINAL_STATUSES.has(status)) {
                return false;
            }

            if (normalizeText(item?.executionIntent, 'EXECUTE') !== 'EXECUTE') {
                return false;
            }

            const sourceEventId = normalizeText(item?._id, '');
            if (!sourceEventId) {
                return false;
            }

            return !executionBySourceEventId.has(sourceEventId);
        });

        const executionStatusMap = countBy(executions, (item) => normalizeText(item?.status, 'unknown'));
        const executionFailRetryCount = executions.filter((item) => {
            const status = normalizeText(item?.status, 'unknown').toLowerCase();
            return status === 'failed' || status === 'retry';
        }).length;
        const executionRequestedUsdc = sumBy(executions, (item) => item?.requestedUsdc);
        const executionExecutedUsdc = sumBy(executions, (item) => item?.executedUsdc);

        const settlementStatusMap = countBy(settlementTasks, (item) => normalizeText(item?.status, 'pending'));
        const settlementOverdueCount = settlementTasks.filter((item) => {
            const status = normalizeText(item?.status, 'pending').toLowerCase();
            if (status === 'settled' || status === 'closed') {
                return false;
            }

            const nextRetryAt = toSafeNumber(item?.nextRetryAt);
            return nextRetryAt <= 0 || nextRetryAt <= now;
        }).length;

        const openPositions = positions.filter((item) => toSafeNumber(item?.size) > 0);
        const redeemablePositions = openPositions.filter((item) => Boolean(item?.redeemable));

        const sourceMissingIndexes = checkExpectedIndexes(sourceIndexDocs, [
            {
                label: 'activityKey 唯一索引',
                key: { activityKey: 1 },
                unique: true,
            },
            {
                label: 'status+nextRetryAt+timestamp 索引',
                key: { status: 1, nextRetryAt: 1, timestamp: 1 },
            },
        ]);

        const executionMissingIndexes = checkExpectedIndexes(executionIndexDocs, [
            {
                label: 'sourceEventId 唯一索引',
                key: { sourceEventId: 1 },
                unique: true,
            },
        ]);

        const settlementMissingIndexes = checkExpectedIndexes(settlementIndexDocs, [
            {
                label: 'conditionId 唯一索引',
                key: { conditionId: 1 },
                unique: true,
            },
            {
                label: 'status+nextRetryAt 索引',
                key: { status: 1, nextRetryAt: 1 },
            },
        ]);

        const summary = {
            input: {
                scopeKey: scope.scopeKey,
                scopeSource: scope.scopeSource,
                range,
                rangeLabel: formatRangeLabel(range),
                envFilePath: ENV_FILE_PATH,
                mongoUriLoadedFrom: argv.mongoUri ? '--mongo-uri' : 'MONGO_URI',
            },
            collections,
            source: {
                total: sourceEvents.length,
                queueCount: sourceQueueEvents.length,
                queuePct: pct(sourceQueueEvents.length, sourceEvents.length),
                queueAgeP50Minutes: quantile(sourceQueueAgesMinutes, 0.5),
                queueAgeP90Minutes: quantile(sourceQueueAgesMinutes, 0.9),
                terminalWithoutExecutionCount: terminalExecuteWithoutExecution.length,
                statusCounts: takeTopEntries(sourceStatusMap, argv.top).map(([key, value]) => ({
                    key,
                    value,
                })),
                executionIntentCounts: takeTopEntries(
                    countBy(sourceEvents, (item) => normalizeText(item?.executionIntent, 'UNSET')),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                snapshotStatusCounts: takeTopEntries(
                    countBy(sourceEvents, (item) => normalizeText(item?.snapshotStatus, 'UNKNOWN')),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                topErrors: buildTopReasonItems(sourceEvents, (item) => item?.lastError, argv.top),
                queueTopConditions: buildTopConditionItems(sourceQueueEvents, argv.top),
            },
            execution: {
                total: executions.length,
                requestedUsdc: executionRequestedUsdc,
                executedUsdc: executionExecutedUsdc,
                fulfillmentPct: pct(executionExecutedUsdc, executionRequestedUsdc),
                failRetryPct: pct(executionFailRetryCount, executions.length),
                statusCounts: takeTopEntries(executionStatusMap, argv.top).map(([key, value]) => ({
                    key,
                    value,
                })),
                actionCounts: takeTopEntries(
                    countBy(executions, (item) => normalizeText(item?.action, 'unknown')),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
                topReasons: buildTopReasonItems(executions, (item) => item?.reason, argv.top),
                policyTrailCounts: takeTopEntries(
                    executions.reduce((counts, item) => {
                        const trails = Array.isArray(item?.policyTrail) ? item.policyTrail : [];
                        for (const trail of trails) {
                            const key = normalizeText(trail, 'UNKNOWN');
                            if (key === 'UNKNOWN') {
                                continue;
                            }
                            counts.set(key, (counts.get(key) || 0) + 1);
                        }

                        return counts;
                    }, new Map()),
                    argv.top
                ).map(([key, value]) => ({ key, value })),
            },
            settlement: {
                total: settlementTasks.length,
                overdueCount: settlementOverdueCount,
                avgRetryCount:
                    settlementTasks.length > 0
                        ? sumBy(settlementTasks, (item) => item?.retryCount) / settlementTasks.length
                        : 0,
                statusCounts: takeTopEntries(settlementStatusMap, argv.top).map(([key, value]) => ({
                    key,
                    value,
                })),
                topReasons: buildTopReasonItems(settlementTasks, (item) => item?.reason, argv.top),
                winnerKnownCount: settlementTasks.filter((item) => normalizeText(item?.winnerOutcome, '')).length,
            },
            positions: {
                total: positions.length,
                openCount: openPositions.length,
                redeemableCount: redeemablePositions.length,
                totalSize: sumBy(openPositions, (item) => item?.size),
                totalMarketValue: sumBy(openPositions, (item) => item?.marketValue),
            },
            portfolio: {
                totalEquity: toSafeNumber(portfolio?.totalEquity),
                cashBalance: toSafeNumber(portfolio?.cashBalance),
                activeExposureUsdc: toSafeNumber(portfolio?.activeExposureUsdc),
                openPositionCount: toSafeNumber(portfolio?.openPositionCount),
                positionsMarketValue: toSafeNumber(portfolio?.positionsMarketValue),
                realizedPnl: toSafeNumber(portfolio?.realizedPnl),
            },
            indexHealth: {
                sourceMissing: sourceMissingIndexes,
                executionMissing: executionMissingIndexes,
                settlementMissing: settlementMissingIndexes,
            },
            suggestions: [],
        };

        pushSuggestion(
            summary.suggestions,
            summary.source.total > 0 && summary.source.queuePct >= 20,
            'source_events 队列积压超过 20%，建议优先检查 monitor 拉取抖动与执行节点吞吐。'
        );
        pushSuggestion(
            summary.suggestions,
            summary.execution.total > 0 && summary.execution.failRetryPct >= 15,
            'execution 的 failed+retry 占比偏高，建议按 submit/confirm/reconcile 三阶段拆分失败预算。'
        );
        pushSuggestion(
            summary.suggestions,
            summary.execution.total > 0 && summary.execution.fulfillmentPct < 85,
            '请求金额与实际成交金额偏离较大，建议针对 BUY/SELL 分别检查滑点与盘口深度阈值。'
        );
        pushSuggestion(
            summary.suggestions,
            summary.settlement.overdueCount > 0,
            '存在到期未处理的 settlement task，建议优先排查 resolved 判定与下一次重试调度。'
        );
        pushSuggestion(
            summary.suggestions,
            summary.source.terminalWithoutExecutionCount > 0,
            '存在 EXECUTE 终态事件缺少 execution 记录，建议抽样核查是否由结算跳过导致的预期行为。'
        );
        pushSuggestion(
            summary.suggestions,
            sourceMissingIndexes.length + executionMissingIndexes.length + settlementMissingIndexes.length > 0,
            '检测到缺失索引，建议先补齐索引再继续压测，否则会放大队列积压与重试成本。'
        );

        if (summary.suggestions.length === 0) {
            summary.suggestions.push(
                '当前窗口未发现明显数据库瓶颈，建议继续按小时采样并和日志脚本联合观测趋势。'
            );
        }

        if (argv.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        console.log(renderSummaryText(summary));
    } finally {
        await closeMongo();
    }
};

run().catch((error) => {
    console.error(`db-improvement-report 执行失败: ${error?.message || error}`);
    process.exit(1);
});
