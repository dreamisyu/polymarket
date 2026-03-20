import {
    ENV_FILE_PATH,
    averageBy,
    buildTimeRange,
    buildTimeRangeFilter,
    closeMongo,
    connectMongo,
    countBy,
    fetchCollectionDocs,
    fetchSingleDoc,
    formatAgeMinutes,
    formatCount,
    formatPct,
    formatTimestamp,
    formatUsd,
    getCopyExecutionBatchCollectionName,
    getCopyIntentBufferCollectionName,
    getTraceCollectionNames,
    getTraceRuntimeNamespace,
    getUserActivityCollectionName,
    normalizeReason,
    pct,
    pushSuggestion,
    quantile,
    readEnv,
    requireEnvValue,
    sumBy,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';

const DEFAULT_MODE = readEnv('EXECUTION_MODE') === 'trace' ? 'trace' : 'live';
const DEFAULT_TRACE_ID = readEnv('TRACE_ID') || 'default';
const DEFAULT_USER_ADDRESS = readEnv('USER_ADDRESS') || '';
const DEFAULT_MONGO_URI = readEnv('MONGO_URI') || '';
const DEFAULT_TOP = 8;

const parseArgs = (argv) => {
    const parsed = {
        mode: DEFAULT_MODE,
        traceId: DEFAULT_TRACE_ID,
        userAddress: DEFAULT_USER_ADDRESS,
        mongoUri: DEFAULT_MONGO_URI,
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

        if ((current === '--mode' || current === '-m') && argv[index + 1]) {
            parsed.mode = argv[index + 1] === 'trace' ? 'trace' : 'live';
            index += 1;
            continue;
        }

        if ((current === '--trace-id' || current === '-t') && argv[index + 1]) {
            parsed.traceId = argv[index + 1];
            index += 1;
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

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/db-improvement-report.mjs [--mode live|trace] [--trace-id default] [--user-address 0x...] [--hours 24] [--json]

说明:
  1. 默认读取当前工作目录或项目根目录的 .env
  2. 聚合 user_activities、copy_execution_batches、trace_executions 等集合，定位系统瓶颈
  3. 默认统计最近 24 小时，可通过 --hours / --since-ts / --until-ts 覆盖
  4. 输出会给出漏斗、主要原因与建议优化点
`);
    process.exit(0);
}

const getSourceTradeCount = (item) => Math.max(toSafeNumber(item?.sourceTradeCount, 1), 1);

const buildReasonSummary = (items, getter, top) => {
    const counts = new Map();
    for (const item of items) {
        const reason = normalizeReason(getter(item));
        if (reason === 'UNKNOWN') {
            continue;
        }

        counts.set(reason, (counts.get(reason) || 0) + 1);
    }

    return takeTopEntries(counts, top).map(([reason, count]) => ({ reason, count }));
};

const buildKeyCountItems = (items, keyGetter, valueGetter, top) => {
    const counts = new Map();
    for (const item of items) {
        const key = String(keyGetter(item) || '').trim() || 'UNKNOWN';
        const nextValue = (counts.get(key) || 0) + toSafeNumber(valueGetter(item), 1);
        counts.set(key, nextValue);
    }

    return takeTopEntries(counts, top).map(([key, value]) => ({ key, value }));
};

const summarizeSourceActivities = (activities, top) => {
    const tradeActivities = activities.filter(
        (item) => String(item.type || '').toUpperCase() === 'TRADE'
    );
    const buyTrades = tradeActivities.filter(
        (item) => String(item.side || '').toUpperCase() === 'BUY'
    );
    const smallBuyTrades = buyTrades.filter((item) => toSafeNumber(item.usdcSize) < 1);
    const mergedActivities = activities.filter((item) => getSourceTradeCount(item) > 1);
    const totalRawTrades = sumBy(activities, (item) => getSourceTradeCount(item));
    const totalRawBuyTrades = sumBy(buyTrades, (item) => getSourceTradeCount(item));
    const totalMergedTradeSavings = Math.max(totalRawTrades - activities.length, 0);
    const totalMergedBuySavings = Math.max(totalRawBuyTrades - buyTrades.length, 0);
    const pendingStatuses = activities.filter(
        (item) =>
            !String(item.botStatus || '').trim() ||
            String(item.botStatus || '').trim() === 'PENDING'
    );

    return {
        totalDocs: activities.length,
        totalRawTrades,
        mergedActivityDocs: mergedActivities.length,
        mergedTradeSavings: totalMergedTradeSavings,
        mergeCompressionPct: pct(totalMergedTradeSavings, totalRawTrades),
        byType: takeTopEntries(
            countBy(activities, (item) => item.type || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        byExecutionIntent: takeTopEntries(
            countBy(activities, (item) => item.executionIntent || 'UNSET'),
            top
        ).map(([key, value]) => ({ key, value })),
        byBotStatus: takeTopEntries(
            countBy(activities, (item) => item.botStatus || 'PENDING'),
            top
        ).map(([key, value]) => ({ key, value })),
        bySnapshotStatus: takeTopEntries(
            countBy(activities, (item) => item.snapshotStatus || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        topBotLastErrors: buildReasonSummary(activities, (item) => item.botLastError, top),
        buyTradeSummary: {
            totalDocs: buyTrades.length,
            totalRawTrades: totalRawBuyTrades,
            mergedDocs: buyTrades.filter((item) => getSourceTradeCount(item) > 1).length,
            mergedTradeSavings: totalMergedBuySavings,
            smallBuyDocs: smallBuyTrades.length,
            smallBuyDocPct: pct(smallBuyTrades.length, buyTrades.length),
            smallBuyRawTrades: sumBy(smallBuyTrades, (item) => getSourceTradeCount(item)),
            requestedUsdcP25: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.25
            ),
            requestedUsdcP50: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.5
            ),
            requestedUsdcP75: quantile(
                buyTrades.map((item) => item.usdcSize),
                0.75
            ),
            requestedUsdcTotal: sumBy(buyTrades, (item) => item.usdcSize),
        },
        pendingCount: pendingStatuses.length,
        topConditions: buildKeyCountItems(
            activities,
            (item) => item.title || item.conditionId || 'UNKNOWN',
            (item) => getSourceTradeCount(item),
            top
        ).map((item) => ({
            title: item.key,
            rawTradeCount: item.value,
        })),
    };
};

const summarizeBatches = (batches, top) => {
    const activeBatches = batches.filter((item) =>
        ['READY', 'PROCESSING', 'SUBMITTED'].includes(String(item.status || '').toUpperCase())
    );
    const completedBatches = batches.filter((item) =>
        ['CONFIRMED', 'SKIPPED', 'FAILED'].includes(String(item.status || '').toUpperCase())
    );

    return {
        totalDocs: batches.length,
        statusCounts: takeTopEntries(
            countBy(batches, (item) => item.status || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        totalRequestedUsdc: sumBy(batches, (item) => item.requestedUsdc),
        totalRequestedSize: sumBy(batches, (item) => item.requestedSize),
        totalSourceTrades: sumBy(batches, (item) => getSourceTradeCount(item)),
        avgSourceTradesPerBatch: averageBy(batches, (item) => getSourceTradeCount(item)),
        retryingCount: batches.filter((item) => toSafeNumber(item.retryCount) > 0).length,
        activeCount: activeBatches.length,
        completedCount: completedBatches.length,
        topReasons: buildReasonSummary(batches, (item) => item.reason, top),
        submissionStatusCounts: takeTopEntries(
            countBy(batches, (item) => item.submissionStatus || 'UNSET'),
            top
        ).map(([key, value]) => ({ key, value })),
    };
};

const summarizeBuffers = (buffers, top) => ({
    totalDocs: buffers.length,
    stateCounts: takeTopEntries(
        countBy(buffers, (item) => item.state || 'UNKNOWN'),
        top
    ).map(([key, value]) => ({ key, value })),
    totalSourceTrades: sumBy(buffers, (item) => getSourceTradeCount(item)),
    topReasons: buildReasonSummary(buffers, (item) => item.reason, top),
});

const summarizeTraceExecutions = (executions, top) => {
    const filled = executions.filter(
        (item) => String(item.status || '').toUpperCase() === 'FILLED'
    );
    const skipped = executions.filter(
        (item) => String(item.status || '').toUpperCase() === 'SKIPPED'
    );
    const failed = executions.filter(
        (item) => String(item.status || '').toUpperCase() === 'FAILED'
    );

    return {
        totalDocs: executions.length,
        statusCounts: takeTopEntries(
            countBy(executions, (item) => item.status || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        executionConditionCounts: takeTopEntries(
            countBy(executions, (item) => item.executionCondition || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        totalRequestedUsdc: sumBy(executions, (item) => item.requestedUsdc),
        totalExecutedUsdc: sumBy(executions, (item) => item.executedUsdc),
        totalSourceTrades: sumBy(executions, (item) => getSourceTradeCount(item)),
        filledCount: filled.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
        settleFilledCount: filled.filter(
            (item) => String(item.executionCondition || '').toLowerCase() === 'settle'
        ).length,
        topReasons: buildReasonSummary([...skipped, ...failed], (item) => item.reason, top),
    };
};

const summarizeSettlementTasks = (tasks, top) => {
    const now = Date.now();
    const openTasks = tasks.filter((item) =>
        ['PENDING', 'PROCESSING'].includes(String(item.status || '').toUpperCase())
    );

    const overdueTasks = openTasks.filter(
        (item) => toSafeNumber(item.nextRetryAt) > 0 && toSafeNumber(item.nextRetryAt) <= now
    );
    const oldestOpenTaskTs = openTasks.reduce((minTs, item) => {
        const candidate = toSafeNumber(item.sourceTimestamp || item.createdAt);
        if (candidate <= 0) {
            return minTs;
        }

        if (minTs <= 0) {
            return candidate;
        }

        return Math.min(minTs, candidate);
    }, 0);

    return {
        totalDocs: tasks.length,
        statusCounts: takeTopEntries(
            countBy(tasks, (item) => item.status || 'UNKNOWN'),
            top
        ).map(([key, value]) => ({ key, value })),
        overdueCount: overdueTasks.length,
        openCount: openTasks.length,
        oldestOpenTaskAt: oldestOpenTaskTs,
        oldestOpenAgeMinutes:
            oldestOpenTaskTs > 0 ? (Date.now() - oldestOpenTaskTs) / (60 * 1000) : 0,
        topReasons: buildReasonSummary(tasks, (item) => item.reason, top),
    };
};

const buildSuggestions = ({
    mode,
    sourceActivitySummary,
    batchSummary,
    bufferSummary,
    traceExecutionSummary,
    settlementSummary,
}) => {
    const suggestions = [];
    const smallBuyPct = toSafeNumber(sourceActivitySummary?.buyTradeSummary?.smallBuyDocPct);
    const mergeCompressionPct = toSafeNumber(sourceActivitySummary?.mergeCompressionPct);
    const staleOrPartialSnapshots =
        sumBy(sourceActivitySummary?.bySnapshotStatus || [], (item) =>
            ['PARTIAL', 'STALE'].includes(String(item.key || '').toUpperCase()) ? item.value : 0
        ) || 0;
    const snapshotTotal = sumBy(
        sourceActivitySummary?.bySnapshotStatus || [],
        (item) => item.value
    );
    const retryRate = pct(batchSummary?.retryingCount, batchSummary?.totalDocs);

    pushSuggestion(
        suggestions,
        smallBuyPct >= 25 && mergeCompressionPct <= 10,
        '小额买单占比仍高且监视器压缩收益有限，优先继续优化监视器合并键或扩大相邻合并窗口。'
    );
    pushSuggestion(
        suggestions,
        pct(staleOrPartialSnapshots, snapshotTotal) >= 20,
        '源账户快照中 PARTIAL/STALE 占比偏高，建议继续补快照质量告警，并优先修复快照缺口导致的定额失真。'
    );
    pushSuggestion(
        suggestions,
        retryRate >= 20,
        '执行批次重试率偏高，建议结合运行日志继续拆分确认异常、滑点失败、余额读取失败等原因。'
    );
    pushSuggestion(
        suggestions,
        toSafeNumber(bufferSummary?.totalDocs) > 0,
        '库中仍存在 legacy copy_intent_buffers，建议清理旧集合或确认没有残余旧链路在回写。'
    );

    if (mode === 'trace') {
        pushSuggestion(
            suggestions,
            toSafeNumber(settlementSummary?.overdueCount) > 0,
            'trace 结算任务存在逾期未处理 condition，建议检查结算 worker 调度、市场解析缓存和重试退避。'
        );
        pushSuggestion(
            suggestions,
            pct(traceExecutionSummary?.skippedCount, traceExecutionSummary?.totalDocs) >= 40,
            'trace 跳过率仍高，建议把 top skip reason 与目标账户交易画像一起看，确认是否还需要更激进的监视器合并或补齐策略。'
        );
    } else {
        pushSuggestion(
            suggestions,
            pct(sourceActivitySummary?.pendingCount, sourceActivitySummary?.totalDocs) >= 20,
            '源活动里待处理记录占比偏高，建议继续收紧执行器主循环里的积压监控和批次老化告警。'
        );
    }

    if (suggestions.length === 0) {
        suggestions.push(
            '当前库内指标未出现明显单点瓶颈，下一步建议结合运行日志脚本进一步查看异常聚类。'
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
    lines.push('DB 改进点分析');
    lines.push(`- 模式: ${summary.input.mode}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- 用户地址: ${summary.input.userAddress}`);

    lines.push('');
    lines.push('源活动概览');
    lines.push(`- 文档数: ${formatCount(summary.sourceActivities.totalDocs)}`);
    lines.push(`- 折算原始交易数: ${formatCount(summary.sourceActivities.totalRawTrades)}`);
    lines.push(
        `- 已压缩交易数: ${formatCount(summary.sourceActivities.mergedTradeSavings)} (${formatPct(summary.sourceActivities.mergeCompressionPct)})`
    );
    lines.push(`- BUY 文档数: ${formatCount(summary.sourceActivities.buyTradeSummary.totalDocs)}`);
    lines.push(
        `- BUY 中 <1u 占比: ${formatPct(summary.sourceActivities.buyTradeSummary.smallBuyDocPct)}`
    );
    lines.push(
        `- BUY usdc 分位: P25=${formatUsd(summary.sourceActivities.buyTradeSummary.requestedUsdcP25)} P50=${formatUsd(summary.sourceActivities.buyTradeSummary.requestedUsdcP50)} P75=${formatUsd(summary.sourceActivities.buyTradeSummary.requestedUsdcP75)}`
    );
    lines.push(
        ...renderTopItems(
            '活动类型',
            summary.sourceActivities.byType,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '执行状态',
            summary.sourceActivities.byBotStatus,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '快照状态',
            summary.sourceActivities.bySnapshotStatus,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '主要 botLastError',
            summary.sourceActivities.topBotLastErrors,
            (item) => `${item.reason}: ${item.count}`
        )
    );

    lines.push('');
    lines.push('执行批次概览');
    lines.push(`- 批次数: ${formatCount(summary.batches.totalDocs)}`);
    lines.push(`- 批次覆盖源交易数: ${formatCount(summary.batches.totalSourceTrades)}`);
    lines.push(
        `- 平均每批覆盖源交易: ${toSafeNumber(summary.batches.avgSourceTradesPerBatch).toFixed(2)}`
    );
    lines.push(`- 重试批次数: ${formatCount(summary.batches.retryingCount)}`);
    lines.push(
        ...renderTopItems(
            '批次状态',
            summary.batches.statusCounts,
            (item) => `${item.key}: ${item.value}`
        )
    );
    lines.push(
        ...renderTopItems(
            '批次原因',
            summary.batches.topReasons,
            (item) => `${item.reason}: ${item.count}`
        )
    );

    lines.push('');
    lines.push('遗留缓冲区');
    lines.push(`- 文档数: ${formatCount(summary.buffers.totalDocs)}`);
    lines.push(
        ...renderTopItems(
            '缓冲状态',
            summary.buffers.stateCounts,
            (item) => `${item.key}: ${item.value}`
        )
    );

    if (summary.traceExecutions) {
        lines.push('');
        lines.push('Trace 执行概览');
        lines.push(`- 执行记录数: ${formatCount(summary.traceExecutions.totalDocs)}`);
        lines.push(
            `- FILLED / SKIPPED / FAILED: ${formatCount(summary.traceExecutions.filledCount)} / ${formatCount(summary.traceExecutions.skippedCount)} / ${formatCount(summary.traceExecutions.failedCount)}`
        );
        lines.push(`- settle FILLED 数: ${formatCount(summary.traceExecutions.settleFilledCount)}`);
        lines.push(
            ...renderTopItems(
                '执行条件',
                summary.traceExecutions.executionConditionCounts,
                (item) => `${item.key}: ${item.value}`
            )
        );
        lines.push(
            ...renderTopItems(
                'Trace 主要原因',
                summary.traceExecutions.topReasons,
                (item) => `${item.reason}: ${item.count}`
            )
        );
    }

    if (summary.settlementTasks) {
        lines.push('');
        lines.push('Trace 结算任务');
        lines.push(`- 任务数: ${formatCount(summary.settlementTasks.totalDocs)}`);
        lines.push(
            `- Open / Overdue: ${formatCount(summary.settlementTasks.openCount)} / ${formatCount(summary.settlementTasks.overdueCount)}`
        );
        lines.push(
            `- 最老 open 任务: ${summary.settlementTasks.oldestOpenTaskAt ? `${formatTimestamp(summary.settlementTasks.oldestOpenTaskAt)} (${formatAgeMinutes(summary.settlementTasks.oldestOpenAgeMinutes)})` : '-'}`
        );
        lines.push(
            ...renderTopItems(
                '结算任务状态',
                summary.settlementTasks.statusCounts,
                (item) => `${item.key}: ${item.value}`
            )
        );
        lines.push(
            ...renderTopItems(
                '结算任务原因',
                summary.settlementTasks.topReasons,
                (item) => `${item.reason}: ${item.count}`
            )
        );
    }

    if (summary.tracePortfolio) {
        lines.push('');
        lines.push('Trace 资产');
        lines.push(`- cashBalance: ${formatUsd(summary.tracePortfolio.cashBalance)}`);
        lines.push(`- totalEquity: ${formatUsd(summary.tracePortfolio.totalEquity)}`);
        lines.push(`- netPnl: ${formatUsd(summary.tracePortfolio.netPnl)}`);
        lines.push(`- lastUpdatedAt: ${formatTimestamp(summary.tracePortfolio.lastUpdatedAt)}`);
    }

    lines.push('');
    lines.push('建议');
    for (const suggestion of summary.suggestions) {
        lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
};

const main = async () => {
    const mode = argv.mode === 'trace' ? 'trace' : 'live';
    const mongoUri = requireEnvValue(argv.mongoUri, 'MONGO_URI');
    const userAddress = requireEnvValue(argv.userAddress, 'USER_ADDRESS');
    const range = buildTimeRange({
        hours: argv.hours,
        sinceTs: argv.sinceTs,
        untilTs: argv.untilTs,
    });

    await connectMongo(mongoUri);

    try {
        const sourceActivityCollection = getUserActivityCollectionName(userAddress);
        const sourceActivities = await fetchCollectionDocs(
            sourceActivityCollection,
            buildTimeRangeFilter('timestamp', range),
            { sort: { timestamp: 1 } }
        );

        const namespace = mode === 'trace' ? getTraceRuntimeNamespace(argv.traceId) : '';
        const batchCollection = getCopyExecutionBatchCollectionName(userAddress, namespace);
        const bufferCollection = getCopyIntentBufferCollectionName(userAddress, namespace);
        const batches = await fetchCollectionDocs(batchCollection, {}, { sort: { createdAt: 1 } });
        const buffers = await fetchCollectionDocs(bufferCollection, {}, { sort: { createdAt: 1 } });

        const traceCollections =
            mode === 'trace' ? getTraceCollectionNames(userAddress, argv.traceId) : null;
        const traceExecutions = traceCollections
            ? await fetchCollectionDocs(
                  traceCollections.execution,
                  buildTimeRangeFilter('sourceTimestamp', range),
                  { sort: { sourceTimestamp: 1 } }
              )
            : [];
        const settlementTasks = traceCollections
            ? await fetchCollectionDocs(
                  traceCollections.settlementTask,
                  {},
                  { sort: { createdAt: 1 } }
              )
            : [];
        const tracePortfolio = traceCollections
            ? await fetchSingleDoc(traceCollections.portfolio, {}, { sort: { updatedAt: -1 } })
            : null;

        const sourceActivitySummary = summarizeSourceActivities(sourceActivities, argv.top);
        const batchSummary = summarizeBatches(batches, argv.top);
        const bufferSummary = summarizeBuffers(buffers, argv.top);
        const traceExecutionSummary =
            mode === 'trace' ? summarizeTraceExecutions(traceExecutions, argv.top) : null;
        const settlementSummary =
            mode === 'trace' ? summarizeSettlementTasks(settlementTasks, argv.top) : null;

        const summary = {
            generatedAt: new Date().toISOString(),
            input: {
                mode,
                traceId: argv.traceId,
                userAddress,
                mongoUriLoadedFrom: ENV_FILE_PATH,
                range,
                rangeLabel: `${range.sinceTs ? formatTimestamp(range.sinceTs) : '-∞'} ~ ${
                    range.untilTs ? formatTimestamp(range.untilTs) : '+∞'
                }`,
            },
            sourceActivities: sourceActivitySummary,
            batches: batchSummary,
            buffers: bufferSummary,
            traceExecutions: traceExecutionSummary,
            settlementTasks: settlementSummary,
            tracePortfolio,
        };

        summary.suggestions = buildSuggestions({
            mode,
            sourceActivitySummary,
            batchSummary,
            bufferSummary,
            traceExecutionSummary,
            settlementSummary,
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
    console.error(`生成 DB 改进点报告失败: ${error.message}`);
    await closeMongo();
    process.exit(1);
});
