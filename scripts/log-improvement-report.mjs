import { existsSync, readFileSync } from 'node:fs';
import {
    formatPct,
    pct,
    pushSuggestion,
    readEnv,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';

const DEFAULT_TOP = 10;

const ISSUE_RULES = [
    {
        id: 'monitor_sync',
        label: '监控同步异常',
        pattern: /活动接口不可用|同步活动失败|fetch.*activity|cursor|分页|monitor.*error|monitor.*warn/i,
        suggestion: '监控链路出现抖动，建议单独监控 activity 拉取耗时、分页推进与失败预算。',
    },
    {
        id: 'snapshot_context',
        label: '快照上下文缺失',
        pattern: /快照|snapshot|余额读取失败|持仓接口不可用|source snapshot/i,
        suggestion: '快照与余额上下文质量不足，建议增加独立健康指标并在执行前兜底降级。',
    },
    {
        id: 'execution_submit',
        label: '下单提交失败',
        pattern: /提交失败|submit.*fail|下单失败|order.*reject|slippage|insufficient/i,
        suggestion: '下单提交阶段失败偏多，建议拆分盘口不足、滑点超限、余额不足三类统计。',
    },
    {
        id: 'execution_confirm',
        label: '确认/回写异常',
        pattern: /确认异常|未确认|reconcile|confirm.*timeout|confirmation|回写失败/i,
        suggestion: '确认链路存在超时或回写问题，建议单独监控确认耗时分布和超时后补偿路径。',
    },
    {
        id: 'settlement_retry',
        label: '结算重试堆积',
        pattern: /结算|settlement|resolved|redeem|markRetry|稍后重试/i,
        suggestion: '结算重试仍在堆积，建议按 condition 维度观察 retry 次数和下次调度延迟。',
    },
    {
        id: 'websocket',
        label: 'WebSocket 稳定性问题',
        pattern: /websocket|ws.*close|ws.*error|心跳|reconnect/i,
        suggestion: '实时链路不稳定，建议对 market/user 通道分别统计断线频次与恢复时长。',
    },
    {
        id: 'db_write',
        label: '数据库写入问题',
        pattern: /Mongo|Mongoose|E11000|duplicate key|write conflict|bulkWrite/i,
        suggestion: '数据库写入冲突影响吞吐，建议核查唯一键设计和批量写入重试策略。',
    },
    {
        id: 'env_or_config',
        label: '配置缺失/非法',
        pattern: /未配置|must be|invalid.*config|ENV|MONGO_URI|SOURCE_WALLET|TARGET_WALLET/i,
        suggestion: '存在配置错误日志，建议在启动前增加配置自检并输出关键参数快照。',
    },
];

const parseArgs = (argv) => {
    const parsed = {
        files: [],
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

        if ((current === '--file' || current === '-f') && argv[index + 1]) {
            parsed.files.push(
                ...argv[index + 1]
                    .split(',')
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            );
            index += 1;
            continue;
        }

        if (current === '--top' && argv[index + 1]) {
            parsed.top = Math.max(Number.parseInt(argv[index + 1], 10) || DEFAULT_TOP, 1);
            index += 1;
        }
    }

    parsed.files = Array.from(new Set(parsed.files));
    return parsed;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/log-improvement-report.mjs --file logs/bot.log [--file logs/worker.log] [--top 10] [--json]
  cat logs/bot.log | node scripts/log-improvement-report.mjs --json

说明:
  1. 支持 pino JSON 日志与普通文本日志混合分析。
  2. 若未传 --file，则优先读取 stdin；stdin 为空时回退到 LOG_FILE_PATH。
`);
    process.exit(0);
}

const stripAnsi = (value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '');

const readInput = () => {
    if (argv.files.length > 0) {
        const chunks = [];
        for (const filePath of argv.files) {
            if (!existsSync(filePath)) {
                throw new Error(`日志文件不存在: ${filePath}`);
            }

            chunks.push(readFileSync(filePath, 'utf8'));
        }

        return {
            text: chunks.join('\n'),
            source: argv.files.join(', '),
        };
    }

    if (!process.stdin.isTTY) {
        return {
            text: readFileSync(0, 'utf8'),
            source: 'stdin',
        };
    }

    const fallbackPath = readEnv('LOG_FILE_PATH') || 'logs/bot-paper.log';
    if (!existsSync(fallbackPath)) {
        throw new Error(`未找到日志输入（--file / stdin / LOG_FILE_PATH=${fallbackPath}）`);
    }

    return {
        text: readFileSync(fallbackPath, 'utf8'),
        source: fallbackPath,
    };
};

const normalizeSignature = (line) =>
    stripAnsi(line)
        .replace(/0x[a-fA-F0-9]{8,}/g, '0x<hex>')
        .replace(/\b\d{12,}\b/g, '<ts>')
        .replace(/\b\d+\.\d+\b/g, '<num>')
        .replace(/\b\d+\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim();

const parseJsonLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
};

const detectLevel = (payload, line) => {
    const numericLevel = toSafeNumber(payload?.level, -1);
    if (numericLevel >= 50) {
        return 'error';
    }
    if (numericLevel >= 40) {
        return 'warn';
    }
    if (numericLevel >= 30) {
        return 'info';
    }

    const normalized = String(line || '').toLowerCase();
    if (/\berror\b|失败|异常|fatal/i.test(normalized)) {
        return 'error';
    }
    if (/\bwarn\b|警告|重试|retry/i.test(normalized)) {
        return 'warn';
    }

    return 'info';
};

const extractScope = (payload, line) => {
    const fromPayload = String(payload?.scope || payload?.name || '').trim();
    if (fromPayload) {
        return fromPayload;
    }

    const fromBracket = String(line || '').match(/\[([^\]]+)\]/)?.[1] || '';
    if (fromBracket) {
        return fromBracket;
    }

    const fromKey = String(line || '').match(/scope=([^\s]+)/)?.[1] || '';
    return fromKey || 'unknown';
};

const extractByPattern = (line, pattern) => {
    const values = [];
    let matched;
    while ((matched = pattern.exec(line)) !== null) {
        const value = String(matched[1] || '').trim();
        if (value) {
            values.push(value);
        }
    }

    return values;
};

const classifyIssue = (line) => {
    for (const rule of ISSUE_RULES) {
        if (rule.pattern.test(line)) {
            return rule.id;
        }
    }

    return 'other';
};

const ISSUE_LABEL_MAP = ISSUE_RULES.reduce(
    (result, item) => ({
        ...result,
        [item.id]: item.label,
    }),
    { other: '其他' }
);

const ISSUE_SUGGESTION_MAP = ISSUE_RULES.reduce(
    (result, item) => ({
        ...result,
        [item.id]: item.suggestion,
    }),
    {}
);

const summarize = (lines, top) => {
    const levelCounts = new Map();
    const issueCounts = new Map();
    const scopeCounts = new Map();
    const signatureCounts = new Map();
    const conditionCounts = new Map();
    const assetCounts = new Map();
    const issueSamples = new Map();

    let parsedJsonLines = 0;

    for (const line of lines) {
        const normalizedRawLine = stripAnsi(line).trim();
        if (!normalizedRawLine) {
            continue;
        }

        const payload = parseJsonLine(normalizedRawLine);
        if (payload) {
            parsedJsonLines += 1;
        }

        const message = String(payload?.msg || payload?.message || normalizedRawLine).trim();
        const merged = payload
            ? `${normalizedRawLine} ${message}`
            : normalizedRawLine;
        const level = detectLevel(payload, merged);
        const issueId = classifyIssue(merged);
        const scope = extractScope(payload, merged);

        levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
        issueCounts.set(issueId, (issueCounts.get(issueId) || 0) + 1);
        scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);

        if (level === 'warn' || level === 'error') {
            const signature = normalizeSignature(merged);
            signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
        }

        for (const conditionId of extractByPattern(
            merged,
            /(?:conditionId|condition|condition_id)=([^\s,]+)/g
        )) {
            conditionCounts.set(conditionId, (conditionCounts.get(conditionId) || 0) + 1);
        }

        for (const asset of extractByPattern(merged, /(?:asset|token)=([^\s,]+)/g)) {
            assetCounts.set(asset, (assetCounts.get(asset) || 0) + 1);
        }

        if (!issueSamples.has(issueId)) {
            issueSamples.set(issueId, []);
        }

        const samples = issueSamples.get(issueId);
        if (samples.length < 3) {
            samples.push(merged);
        }
    }

    const total = sumMap(levelCounts);
    const errorCount = levelCounts.get('error') || 0;
    const warnCount = levelCounts.get('warn') || 0;

    const summary = {
        totalLines: total,
        parsedJsonLines,
        errorCount,
        warnCount,
        errorPct: pct(errorCount, total),
        warnPct: pct(warnCount, total),
        levelCounts: takeTopEntries(levelCounts, 10).map(([key, value]) => ({ key, value })),
        issueCounts: takeTopEntries(issueCounts, top).map(([issueId, count]) => ({
            issueId,
            label: ISSUE_LABEL_MAP[issueId] || issueId,
            count,
            pct: pct(count, total),
            samples: issueSamples.get(issueId) || [],
        })),
        scopeCounts: takeTopEntries(scopeCounts, top).map(([scope, count]) => ({ scope, count })),
        signatureCounts: takeTopEntries(signatureCounts, top).map(([signature, count]) => ({
            signature,
            count,
        })),
        hotConditions: takeTopEntries(conditionCounts, top).map(([conditionId, count]) => ({
            conditionId,
            count,
        })),
        hotAssets: takeTopEntries(assetCounts, top).map(([asset, count]) => ({
            asset,
            count,
        })),
        suggestions: [],
    };

    pushSuggestion(
        summary.suggestions,
        summary.errorPct >= 5,
        `错误日志占比达到 ${formatPct(summary.errorPct)}，建议把 error 级别按模块拆解并设置独立告警阈值。`
    );
    pushSuggestion(
        summary.suggestions,
        summary.warnPct >= 15,
        `warn 日志占比达到 ${formatPct(summary.warnPct)}，建议筛出可降噪的重复告警，避免掩盖真正异常。`
    );

    for (const issue of summary.issueCounts.slice(0, 3)) {
        const message = ISSUE_SUGGESTION_MAP[issue.issueId];
        if (message && issue.pct >= 5) {
            summary.suggestions.push(`${issue.label}（${formatPct(issue.pct)}）：${message}`);
        }
    }

    if (summary.suggestions.length === 0) {
        summary.suggestions.push('当前日志质量总体稳定，建议持续观察 error/warn 比例趋势。');
    }

    return summary;
};

const sumMap = (map) => [...map.values()].reduce((sum, value) => sum + toSafeNumber(value), 0);

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

const renderText = (result, inputSource) => {
    const lines = [];
    lines.push('日志改进报告（新版本）');
    lines.push(`- 输入源: ${inputSource}`);
    lines.push(`- 总行数: ${result.totalLines}`);
    lines.push(`- JSON 行数: ${result.parsedJsonLines}`);
    lines.push(`- error / warn: ${result.errorCount} (${formatPct(result.errorPct)}) / ${result.warnCount} (${formatPct(result.warnPct)})`);

    lines.push('');
    lines.push(...renderTopItems('问题分类', result.issueCounts, (item) => `${item.label}: ${item.count} (${formatPct(item.pct)})`));
    lines.push(...renderTopItems('热点 scope', result.scopeCounts, (item) => `${item.scope}: ${item.count}`));
    lines.push(...renderTopItems('高频签名（warn+error）', result.signatureCounts, (item) => `${item.count} 次 | ${item.signature}`));
    lines.push(...renderTopItems('热点 condition', result.hotConditions, (item) => `${item.conditionId}: ${item.count}`));
    lines.push(...renderTopItems('热点 asset', result.hotAssets, (item) => `${item.asset}: ${item.count}`));

    lines.push('');
    lines.push('建议');
    for (const suggestion of result.suggestions) {
        lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
};

const run = () => {
    const { text, source } = readInput();
    const lines = text.split(/\r?\n/g);
    const summary = summarize(lines, argv.top);

    if (argv.json) {
        console.log(
            JSON.stringify(
                {
                    input: {
                        source,
                        top: argv.top,
                    },
                    ...summary,
                },
                null,
                2
            )
        );
        return;
    }

    console.log(renderText(summary, source));
};

try {
    run();
} catch (error) {
    console.error(`log-improvement-report 执行失败: ${error?.message || error}`);
    process.exit(1);
}
