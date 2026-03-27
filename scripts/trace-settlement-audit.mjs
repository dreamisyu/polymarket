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
    pct,
    pushSuggestion,
    readEnv,
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

const DEFAULT_TOP_CONDITIONS = 12;
const DEFAULT_TOP_REASONS = 6;
const DEFAULT_HOURS = 72;
const REQUEST_TIMEOUT_MS = 10_000;

const parseArgs = (argv) => {
    const parsed = {
        scopeKey: '',
        sourceWallet: '',
        targetWallet: '',
        runMode: '',
        strategyKind: '',
        mongoUri: '',
        conditionIds: [],
        hours: DEFAULT_HOURS,
        sinceTs: 0,
        untilTs: 0,
        topConditions: DEFAULT_TOP_CONDITIONS,
        topReasons: DEFAULT_TOP_REASONS,
        skipRemote: false,
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

        if ((current === '--condition-id' || current === '-c') && argv[index + 1]) {
            parsed.conditionIds.push(
                ...argv[index + 1]
                    .split(',')
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            );
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

        if (current === '--top-conditions' && argv[index + 1]) {
            parsed.topConditions = Math.max(Number.parseInt(argv[index + 1], 10) || 0, 1);
            index += 1;
            continue;
        }

        if (current === '--top-reasons' && argv[index + 1]) {
            parsed.topReasons = Math.max(Number.parseInt(argv[index + 1], 10) || 0, 1);
            index += 1;
            continue;
        }

        if (current === '--skip-remote') {
            parsed.skipRemote = true;
        }
    }

    parsed.conditionIds = Array.from(new Set(parsed.conditionIds));
    return parsed;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/trace-settlement-audit.mjs [--scope-key key] [--hours 72] [--condition-id 0x...,0x...] [--json]
  node scripts/trace-settlement-audit.mjs --source-wallet 0x... --target-wallet 0x... --run-mode live --strategy-kind signal

说明:
  1. 审计数据来自 settlement_tasks / source_events / executions / positions（新集合结构）。
  2. 默认审计最近 72 小时活动；settlement_tasks 与 positions 为全量读取。
  3. 默认联查 CLOB/Gamma 解析 resolved 状态，可通过 --skip-remote 关闭。
`);
    process.exit(0);
}

const normalizeText = (value, fallback = '') => String(value || '').trim() || fallback;

const lowerText = (value, fallback = '') => normalizeText(value, fallback).toLowerCase();

const parseArrayLike = (value) => {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeText(item, '')).filter(Boolean);
    }

    const normalized = normalizeText(value, '');
    if (!normalized) {
        return [];
    }

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return parsed.map((item) => normalizeText(item, '')).filter(Boolean);
        }
    } catch {
        return normalized
            .split(',')
            .map((item) => normalizeText(item, ''))
            .filter(Boolean);
    }

    return [];
};

const normalizeOutcomeLabel = (value) => lowerText(value, '').replace(/\s+/g, ' ');

const inferWinnerFromTokens = (tokens = []) =>
    normalizeOutcomeLabel(tokens.find((token) => Boolean(token?.winner))?.outcome || '');

const inferWinnerFromOutcomePrices = (outcomes, outcomePrices) => {
    const normalizedOutcomes = parseArrayLike(outcomes);
    const normalizedPrices = parseArrayLike(outcomePrices).map((value) => toSafeNumber(value, -1));

    if (
        normalizedOutcomes.length === 0 ||
        normalizedOutcomes.length !== normalizedPrices.length
    ) {
        return '';
    }

    const winnerIndex = normalizedPrices.findIndex((value) => value >= 0.999);
    if (winnerIndex < 0) {
        return '';
    }

    const losingCount = normalizedPrices.filter(
        (value, index) => index !== winnerIndex && value <= 0.001
    ).length;
    if (losingCount !== normalizedPrices.length - 1) {
        return '';
    }

    return normalizeOutcomeLabel(normalizedOutcomes[winnerIndex]);
};

const deriveResolvedStatus = ({ winnerOutcome, closed, acceptingOrders, umaResolutionStatus }) => {
    const uma = lowerText(umaResolutionStatus, '');
    if (winnerOutcome) {
        return 'resolved';
    }

    if (uma.includes('resolved') || uma.includes('finalized') || uma.includes('settled')) {
        return 'resolved';
    }

    if (closed || acceptingOrders === false) {
        return 'closed';
    }

    return 'open';
};

const fetchJsonWithTimeout = async (url, userAgent) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': userAgent || 'polymarket-copytrading-bot/trace-settlement-audit',
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            return {
                data: null,
                error: `HTTP ${response.status}`,
            };
        }

        return {
            data: await response.json(),
            error: '',
        };
    } catch (error) {
        return {
            data: null,
            error: error?.message || '请求失败',
        };
    } finally {
        clearTimeout(timeout);
    }
};

const fetchConditionResolution = async ({
    conditionId,
    marketSlug,
    clobHttpUrl,
    gammaApiUrl,
    userAgent,
}) => {
    const normalizedConditionId = normalizeText(conditionId, '');
    const normalizedSlug = normalizeText(marketSlug, '');

    if (!normalizedConditionId && !normalizedSlug) {
        return {
            conditionId: normalizedConditionId,
            marketSlug: normalizedSlug,
            status: 'unknown',
            winnerOutcome: '',
            source: 'none',
            error: '缺少 conditionId/marketSlug',
        };
    }

    if (normalizedConditionId) {
        const clobUrl = `${clobHttpUrl.replace(/\/+$/, '')}/markets/${normalizedConditionId}`;
        const clob = await fetchJsonWithTimeout(clobUrl, userAgent);
        if (clob.data) {
            const winnerOutcome = inferWinnerFromTokens(clob.data?.tokens || []);
            const acceptingOrders =
                typeof clob.data?.accepting_orders === 'boolean'
                    ? clob.data.accepting_orders
                    : typeof clob.data?.acceptingOrders === 'boolean'
                      ? clob.data.acceptingOrders
                      : null;
            const resolvedStatus = deriveResolvedStatus({
                winnerOutcome,
                closed: Boolean(clob.data?.closed),
                acceptingOrders,
                umaResolutionStatus: '',
            });

            return {
                conditionId: normalizeText(clob.data?.condition_id || clob.data?.conditionId, normalizedConditionId),
                marketSlug: normalizeText(clob.data?.market_slug || clob.data?.marketSlug, normalizedSlug),
                status: resolvedStatus,
                winnerOutcome,
                source: 'clob',
                error: '',
            };
        }
    }

    if (normalizedSlug) {
        const gammaUrl = `${gammaApiUrl.replace(/\/+$/, '')}/markets/slug/${encodeURIComponent(normalizedSlug)}`;
        const gamma = await fetchJsonWithTimeout(gammaUrl, userAgent);
        const gammaData = Array.isArray(gamma.data) ? gamma.data[0] : gamma.data;

        if (gammaData) {
            const winnerOutcome =
                inferWinnerFromTokens(gammaData?.tokens || []) ||
                inferWinnerFromOutcomePrices(gammaData?.outcomes, gammaData?.outcomePrices);
            const acceptingOrders =
                typeof gammaData?.acceptingOrders === 'boolean' ? gammaData.acceptingOrders : null;
            const resolvedStatus = deriveResolvedStatus({
                winnerOutcome,
                closed: Boolean(gammaData?.closed),
                acceptingOrders,
                umaResolutionStatus: gammaData?.umaResolutionStatus,
            });

            return {
                conditionId: normalizeText(gammaData?.conditionId, normalizedConditionId),
                marketSlug: normalizeText(gammaData?.slug, normalizedSlug),
                status: resolvedStatus,
                winnerOutcome,
                source: 'gamma',
                error: '',
            };
        }

        return {
            conditionId: normalizedConditionId,
            marketSlug: normalizedSlug,
            status: 'unknown',
            winnerOutcome: '',
            source: 'gamma',
            error: gamma.error || 'gamma 未返回数据',
        };
    }

    return {
        conditionId: normalizedConditionId,
        marketSlug: normalizedSlug,
        status: 'unknown',
        winnerOutcome: '',
        source: 'clob',
        error: 'clob 未返回数据',
    };
};

const ensureProfile = (map, conditionId) => {
    const key = normalizeText(conditionId, '');
    if (!key) {
        return null;
    }

    if (!map.has(key)) {
        map.set(key, {
            conditionId: key,
            title: '',
            marketSlug: '',
            taskStatus: 'missing',
            taskRetryCount: 0,
            taskReason: '',
            taskNextRetryAt: 0,
            taskLastCheckedAt: 0,
            taskWinnerOutcome: '',
            sourceStatusCounts: new Map(),
            sourcePendingCount: 0,
            sourceFailedCount: 0,
            sourceLatestTs: 0,
            executionStatusCounts: new Map(),
            executionFailedCount: 0,
            executionRetryCount: 0,
            executionLatestTs: 0,
            openPositionSize: 0,
            redeemableSize: 0,
            openPositionCount: 0,
            findings: [],
            remote: null,
            riskScore: 0,
        });
    }

    return map.get(key);
};

const buildRiskScore = (profile, now) => {
    let score = 0;

    if (profile.taskStatus === 'missing') {
        score += 20;
    }

    if (!['settled', 'closed', 'missing'].includes(profile.taskStatus)) {
        score += 10;
    }

    if (
        !['settled', 'closed'].includes(profile.taskStatus) &&
        profile.taskNextRetryAt > 0 &&
        profile.taskNextRetryAt <= now
    ) {
        score += 10;
    }

    score += profile.taskRetryCount * 2;
    score += profile.sourcePendingCount * 1.5;
    score += profile.executionRetryCount * 1.5;
    score += profile.executionFailedCount * 1.5;
    score += profile.openPositionCount > 0 ? 6 : 0;
    score += profile.redeemableSize > 0 ? 8 : 0;

    return score;
};

const addFinding = (profile, id, message) => {
    profile.findings.push({ id, message });
};

const toSerializableCounts = (map, top) =>
    takeTopEntries(map, top).map(([key, value]) => ({ key, value: toSafeNumber(value) }));

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
    lines.push('结算链路审计（trace-settlement-audit 新版）');
    lines.push(`- scopeKey: ${summary.input.scopeKey}`);
    lines.push(`- 时间范围: ${summary.input.rangeLabel}`);
    lines.push(`- 条件总数: ${summary.overview.conditionUniverseCount}`);
    lines.push(`- 重点审计条件数: ${summary.overview.selectedCount}`);
    lines.push(`- 远程解析: ${summary.input.skipRemote ? '关闭' : '开启'}`);
    lines.push(`- env 路径: ${summary.input.envFilePath}`);

    lines.push('');
    lines.push('总览');
    lines.push(`- settlement 状态分布: ${summary.overview.taskStatusCounts.map((item) => `${item.key}=${item.value}`).join(', ') || '无'}`);
    lines.push(`- 有开仓条件: ${summary.overview.openPositionConditionCount}`);
    lines.push(`- 有 pending source 条件: ${summary.overview.pendingSourceConditionCount}`);
    lines.push(`- 已 resolved 但未 settled: ${summary.overview.resolvedNotSettledCount}`);
    lines.push(`- settled 但仍有残留: ${summary.overview.settledWithResidualCount}`);

    lines.push('');
    lines.push(...renderTopItems('问题分类 Top', summary.issueCounts, (item) => `${item.id}: ${item.count}`));
    lines.push(...renderTopItems('任务原因 Top', summary.topTaskReasons, (item) => `${item.reason}: ${item.count}`));

    lines.push('');
    lines.push('重点条件');
    if (summary.conditions.length === 0) {
        lines.push('- 无可审计条件');
    } else {
        for (const condition of summary.conditions) {
            const findingText =
                condition.findings.length > 0
                    ? condition.findings.map((item) => item.message).join('；')
                    : '无明显异常';
            lines.push(
                `- ${condition.conditionId} | task=${condition.taskStatus} retry=${condition.taskRetryCount} pending=${condition.sourcePendingCount} openSize=${condition.openPositionSize.toFixed(6)} remote=${condition.remoteStatus} findings=${findingText}`
            );
        }
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

    const clobHttpUrl = readEnv('CLOB_HTTP_URL') || 'https://clob.polymarket.com';
    const gammaApiUrl = readEnv('GAMMA_API_URL') || 'https://gamma-api.polymarket.com';

    await connectMongo(mongoUri);

    try {
        const conditionFilter =
            argv.conditionIds.length > 0
                ? { conditionId: { $in: argv.conditionIds } }
                : {};

        const [tasks, positions, sourceEvents, executions] = await Promise.all([
            fetchCollectionDocs(collections.settlementTasks, conditionFilter, {
                projection: {
                    conditionId: 1,
                    title: 1,
                    marketSlug: 1,
                    status: 1,
                    reason: 1,
                    retryCount: 1,
                    nextRetryAt: 1,
                    lastCheckedAt: 1,
                    winnerOutcome: 1,
                },
            }),
            fetchCollectionDocs(collections.positions, conditionFilter, {
                projection: {
                    conditionId: 1,
                    size: 1,
                    redeemable: 1,
                },
            }),
            fetchCollectionDocs(
                collections.sourceEvents,
                {
                    ...conditionFilter,
                    ...buildTimeRangeFilter('timestamp', range),
                },
                {
                    projection: {
                        conditionId: 1,
                        title: 1,
                        slug: 1,
                        status: 1,
                        timestamp: 1,
                    },
                }
            ),
            fetchCollectionDocs(
                collections.executions,
                {
                    ...conditionFilter,
                    ...buildDateRangeFilter('createdAt', range),
                },
                {
                    projection: {
                        conditionId: 1,
                        status: 1,
                        reason: 1,
                        createdAt: 1,
                    },
                }
            ),
        ]);

        const profileMap = new Map();

        for (const task of tasks) {
            const profile = ensureProfile(profileMap, task?.conditionId);
            if (!profile) {
                continue;
            }

            profile.title = normalizeText(task?.title, profile.title);
            profile.marketSlug = normalizeText(task?.marketSlug, profile.marketSlug);
            profile.taskStatus = lowerText(task?.status, 'pending');
            profile.taskRetryCount = toSafeNumber(task?.retryCount);
            profile.taskReason = normalizeText(task?.reason, '');
            profile.taskNextRetryAt = toSafeNumber(task?.nextRetryAt);
            profile.taskLastCheckedAt = toSafeNumber(task?.lastCheckedAt);
            profile.taskWinnerOutcome = normalizeText(task?.winnerOutcome, '');
        }

        for (const position of positions) {
            const profile = ensureProfile(profileMap, position?.conditionId);
            if (!profile) {
                continue;
            }

            const size = Math.max(toSafeNumber(position?.size), 0);
            if (size <= 0) {
                continue;
            }

            profile.openPositionCount += 1;
            profile.openPositionSize += size;
            if (position?.redeemable) {
                profile.redeemableSize += size;
            }
        }

        for (const event of sourceEvents) {
            const profile = ensureProfile(profileMap, event?.conditionId);
            if (!profile) {
                continue;
            }

            profile.title = normalizeText(event?.title, profile.title);
            profile.marketSlug = normalizeText(event?.slug, profile.marketSlug);

            const status = lowerText(event?.status, 'pending');
            profile.sourceStatusCounts.set(status, (profile.sourceStatusCounts.get(status) || 0) + 1);
            if (status === 'pending' || status === 'processing' || status === 'retry') {
                profile.sourcePendingCount += 1;
            }
            if (status === 'failed') {
                profile.sourceFailedCount += 1;
            }

            profile.sourceLatestTs = Math.max(profile.sourceLatestTs, toSafeNumber(event?.timestamp));
        }

        for (const execution of executions) {
            const profile = ensureProfile(profileMap, execution?.conditionId);
            if (!profile) {
                continue;
            }

            const status = lowerText(execution?.status, 'unknown');
            profile.executionStatusCounts.set(status, (profile.executionStatusCounts.get(status) || 0) + 1);
            if (status === 'failed') {
                profile.executionFailedCount += 1;
            }
            if (status === 'retry') {
                profile.executionRetryCount += 1;
            }

            const createdAt = toSafeNumber(new Date(execution?.createdAt || 0).getTime());
            profile.executionLatestTs = Math.max(profile.executionLatestTs, createdAt);
        }

        const now = Date.now();
        let profiles = [...profileMap.values()];

        if (argv.conditionIds.length === 0) {
            profiles = profiles.filter((profile) => {
                return (
                    profile.taskStatus !== 'missing' ||
                    profile.openPositionCount > 0 ||
                    profile.sourcePendingCount > 0 ||
                    profile.executionRetryCount > 0 ||
                    profile.executionFailedCount > 0
                );
            });
        }

        for (const profile of profiles) {
            profile.riskScore = buildRiskScore(profile, now);
        }

        profiles.sort((left, right) => right.riskScore - left.riskScore);

        const selectedProfiles =
            argv.conditionIds.length > 0
                ? profiles
                : profiles.slice(0, argv.topConditions);

        if (!argv.skipRemote) {
            for (const profile of selectedProfiles) {
                profile.remote = await fetchConditionResolution({
                    conditionId: profile.conditionId,
                    marketSlug: profile.marketSlug,
                    clobHttpUrl,
                    gammaApiUrl,
                    userAgent: 'polymarket-copytrading-bot/trace-settlement-audit',
                });
            }
        }

        const issueCounts = new Map();
        const countIssue = (id) => issueCounts.set(id, (issueCounts.get(id) || 0) + 1);

        for (const profile of selectedProfiles) {
            const hasTask = profile.taskStatus !== 'missing';
            const hasResidual = profile.openPositionCount > 0 || profile.sourcePendingCount > 0;
            const taskOverdue =
                hasTask &&
                !['settled', 'closed'].includes(profile.taskStatus) &&
                profile.taskNextRetryAt > 0 &&
                profile.taskNextRetryAt <= now;
            const remoteResolved = lowerText(profile.remote?.status, '') === 'resolved';

            if (!hasTask && hasResidual) {
                addFinding(profile, 'missing_task', '存在残留事件/仓位但缺少 settlement task');
                countIssue('missing_task');
            }

            if (remoteResolved && !['settled', 'closed'].includes(profile.taskStatus)) {
                addFinding(profile, 'resolved_not_settled', '远程已 resolved，但本地任务未 settled');
                countIssue('resolved_not_settled');
            }

            if (profile.taskStatus === 'settled' && hasResidual) {
                addFinding(profile, 'settled_with_residual', '任务已 settled，但仍有残留 source/position');
                countIssue('settled_with_residual');
            }

            if (taskOverdue) {
                addFinding(profile, 'task_overdue', '任务已到 nextRetryAt 但仍未完成');
                countIssue('task_overdue');
            }

            if (profile.taskRetryCount >= 3) {
                addFinding(profile, 'high_retry', `任务重试次数偏高（${profile.taskRetryCount}）`);
                countIssue('high_retry');
            }

            if (profile.executionFailedCount + profile.executionRetryCount > 0) {
                addFinding(
                    profile,
                    'execution_failures',
                    `execution failed/retry=${profile.executionFailedCount + profile.executionRetryCount}`
                );
                countIssue('execution_failures');
            }
        }

        const taskReasonCounts = new Map();
        for (const profile of selectedProfiles) {
            const reason = normalizeText(profile.taskReason, 'UNKNOWN');
            if (reason === 'UNKNOWN') {
                continue;
            }

            taskReasonCounts.set(reason, (taskReasonCounts.get(reason) || 0) + 1);
        }

        const taskStatusCounts = toSerializableCounts(
            countBy(selectedProfiles, (profile) => normalizeText(profile.taskStatus, 'missing')),
            10
        );

        const summary = {
            input: {
                scopeKey: scope.scopeKey,
                scopeSource: scope.scopeSource,
                range,
                rangeLabel: formatRangeLabel(range),
                skipRemote: argv.skipRemote,
                envFilePath: ENV_FILE_PATH,
                mongoUriLoadedFrom: argv.mongoUri ? '--mongo-uri' : 'MONGO_URI',
                filterConditionIds: argv.conditionIds,
            },
            collections,
            overview: {
                conditionUniverseCount: profiles.length,
                selectedCount: selectedProfiles.length,
                openPositionConditionCount: selectedProfiles.filter((profile) => profile.openPositionCount > 0).length,
                pendingSourceConditionCount: selectedProfiles.filter((profile) => profile.sourcePendingCount > 0).length,
                taskStatusCounts,
                resolvedNotSettledCount: selectedProfiles.filter((profile) =>
                    lowerText(profile.remote?.status, '') === 'resolved' &&
                    !['settled', 'closed'].includes(profile.taskStatus)
                ).length,
                settledWithResidualCount: selectedProfiles.filter(
                    (profile) =>
                        profile.taskStatus === 'settled' &&
                        (profile.sourcePendingCount > 0 || profile.openPositionCount > 0)
                ).length,
            },
            issueCounts: takeTopEntries(issueCounts, 10).map(([id, count]) => ({ id, count })),
            topTaskReasons: takeTopEntries(taskReasonCounts, argv.topReasons).map(([reason, count]) => ({
                reason,
                count,
            })),
            conditions: selectedProfiles.map((profile) => ({
                conditionId: profile.conditionId,
                title: profile.title,
                marketSlug: profile.marketSlug,
                taskStatus: profile.taskStatus,
                taskRetryCount: profile.taskRetryCount,
                taskReason: profile.taskReason,
                taskNextRetryAt: profile.taskNextRetryAt,
                taskLastCheckedAt: profile.taskLastCheckedAt,
                taskWinnerOutcome: profile.taskWinnerOutcome,
                sourcePendingCount: profile.sourcePendingCount,
                sourceFailedCount: profile.sourceFailedCount,
                sourceStatusCounts: toSerializableCounts(profile.sourceStatusCounts, 10),
                sourceLatestTs: profile.sourceLatestTs,
                executionFailedCount: profile.executionFailedCount,
                executionRetryCount: profile.executionRetryCount,
                executionStatusCounts: toSerializableCounts(profile.executionStatusCounts, 10),
                executionLatestTs: profile.executionLatestTs,
                openPositionCount: profile.openPositionCount,
                openPositionSize: profile.openPositionSize,
                redeemableSize: profile.redeemableSize,
                remoteStatus: normalizeText(profile.remote?.status, argv.skipRemote ? 'skipped' : 'unknown'),
                remoteWinnerOutcome: normalizeText(profile.remote?.winnerOutcome, ''),
                remoteSource: normalizeText(profile.remote?.source, argv.skipRemote ? 'skipped' : 'unknown'),
                remoteError: normalizeText(profile.remote?.error, ''),
                findings: profile.findings,
                riskScore: profile.riskScore,
            })),
            suggestions: [],
        };

        pushSuggestion(
            summary.suggestions,
            summary.overview.resolvedNotSettledCount > 0,
            `存在 ${summary.overview.resolvedNotSettledCount} 个 condition 远程已 resolved 但本地未 settled，建议优先排查 settlement 调度。`
        );
        pushSuggestion(
            summary.suggestions,
            summary.overview.settledWithResidualCount > 0,
            `存在 ${summary.overview.settledWithResidualCount} 个 condition 已 settled 但仍有残留，建议复核回收和事件清理逻辑。`
        );

        const overdueIssue = summary.issueCounts.find((item) => item.id === 'task_overdue')?.count || 0;
        pushSuggestion(
            summary.suggestions,
            overdueIssue > 0,
            `存在 ${overdueIssue} 个 task_overdue，建议检查 nextRetryAt 计算与 worker 轮询频率。`
        );

        const highRetryIssue = summary.issueCounts.find((item) => item.id === 'high_retry')?.count || 0;
        pushSuggestion(
            summary.suggestions,
            highRetryIssue > 0,
            `存在 ${highRetryIssue} 个高重试任务，建议按 reason 维度做熔断或退避分级。`
        );

        if (!argv.skipRemote) {
            const remoteErrorCount = summary.conditions.filter((item) => item.remoteError).length;
            pushSuggestion(
                summary.suggestions,
                remoteErrorCount > 0,
                `远程解析有 ${remoteErrorCount} 条失败记录，建议检查 API 可用性或加重试缓存。`
            );
        }

        if (summary.suggestions.length === 0) {
            summary.suggestions.push('当前审计窗口未发现明显结算异常，建议持续采样并观察问题分类趋势。');
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
    console.error(`trace-settlement-audit 执行失败: ${error?.message || error}`);
    process.exit(1);
});
