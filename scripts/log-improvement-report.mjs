import { existsSync, readFileSync } from 'fs';
import {
    formatPct,
    formatTimestamp,
    pct,
    pushSuggestion,
    takeTopEntries,
    toSafeNumber,
} from './lib/runtime.mjs';

const DEFAULT_TOP = 10;

const ISSUE_RULES = [
    {
        id: 'market_resolution_rate_limit',
        label: '市场状态接口限流',
        pattern: /\b(?:403|429)\b|rate limit|限流|too many requests/i,
        suggestion: '外部 REST 调用仍有过量倾向，优先继续加缓存、批量化和指数退避。',
    },
    {
        id: 'resolved_market_orderbook_access',
        label: '已结算市场仍访问订单簿',
        pattern: /No orderbook exists|orderbook/i,
        suggestion: 'resolved 市场仍有残留盘口访问，检查结算后 buffer/batch 清扫是否完整。',
    },
    {
        id: 'http_retry_or_failure',
        label: 'HTTP 重试/失败',
        pattern: /请求重试|请求失败 url=|ECONN|ETIMEDOUT|ECONNABORTED|ENOTFOUND/i,
        suggestion: '外部接口稳定性影响执行链路，建议对关键 API 加分层缓存并单独统计失败预算。',
    },
    {
        id: 'small_buy_skip',
        label: '小额买单被跳过',
        pattern: /低于 ?1 ?USDC|最小下单金额|补齐.*不足|已跳过模拟买单/i,
        suggestion: '小额买单仍是主要损耗点，建议结合目标账户画像继续优化监视器合并与补齐阈值。',
    },
    {
        id: 'slippage_reject',
        label: '滑点限制触发',
        pattern: /滑点|slippage/i,
        suggestion: '滑点拒单偏多，建议按市场类型拆分滑点策略，而不是全局统一阈值。',
    },
    {
        id: 'snapshot_quality',
        label: '快照/余额上下文缺失',
        pattern: /持仓接口不可用|快照|余额读取失败|风控上下文失败|源账户现金快照无效/i,
        suggestion: '执行前上下文经常不完整，建议给快照与余额读取增加独立健康度指标。',
    },
    {
        id: 'settlement_retry',
        label: '结算回补重试',
        pattern: /结算回补稍后重试|市场尚未 resolved|自动结算/i,
        suggestion: '结算 worker 仍有重试积压，建议单独统计 condition 级回补耗时与重试曲线。',
    },
    {
        id: 'activity_sync_issue',
        label: '活动同步异常',
        pattern: /同步活动失败|活动接口暂不可用|分页游标未推进|活动抓取窗口无效/i,
        suggestion: '监视器入口存在同步抖动，建议单独增加同步链路告警和游标推进监控。',
    },
    {
        id: 'execution_or_confirmation_error',
        label: '执行/确认异常',
        pattern: /执行异常|确认异常|提交失败|待重试 reason=|稍后重试 reason=/i,
        suggestion: '执行器异常需要继续按提交、确认、回写三个阶段拆分，不要混在一个失败桶里。',
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
  node scripts/log-improvement-report.mjs --file logs/bot.log [--file logs/worker.log] [--json]
  cat logs/bot.log | node scripts/log-improvement-report.mjs --json

说明:
  1. 从运行日志中提取异常聚类、热点 scope、常见 condition/asset
  2. 如果未传 --file 且 stdin 有数据，则自动读取 stdin
  3. 输出会给出日志侧的主要改进建议
`);
    process.exit(0);
}

const stripAnsi = (value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '');

const readInputText = () => {
    if (argv.files.length > 0) {
        const chunks = [];
        for (const filePath of argv.files) {
            if (!existsSync(filePath)) {
                throw new Error(`日志文件不存在: ${filePath}`);
            }

            chunks.push(readFileSync(filePath, 'utf8'));
        }

        return chunks.join('\n');
    }

    if (!process.stdin.isTTY) {
        return readFileSync(0, 'utf8');
    }

    throw new Error('未提供 --file，且 stdin 为空');
};

const normalizeSignature = (line) =>
    stripAnsi(line)
        .replace(/0x[a-fA-F0-9]{8,}/g, '0x<hex>')
        .replace(/\b\d{12,}\b/g, '<ts>')
        .replace(/\b\d+\.\d+\b/g, '<num>')
        .replace(/\b\d+\b/g, '<n>')
        .trim();

const extractScope = (line) => {
    const matched = stripAnsi(line).match(/\[([^\]]+)\]/);
    return matched ? matched[1] : 'unknown';
};

const extractFieldValues = (line, fieldName) => {
    const pattern = new RegExp(`${fieldName}=([^\\s]+)`, 'g');
    const values = [];
    let matched = pattern.exec(line);
    while (matched) {
        values.push(matched[1]);
        matched = pattern.exec(line);
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

const buildIssueLabelMap = () =>
    ISSUE_RULES.reduce(
        (result, rule) => ({
            ...result,
            [rule.id]: rule.label,
        }),
        { other: '其他' }
    );

const summarizeLogLines = (lines, top) => {
    const issueCounts = new Map();
    const scopeCounts = new Map();
    const signatureCounts = new Map();
    const conditionCounts = new Map();
    const assetCounts = new Map();
    const issueSamples = new Map();

    for (const line of lines) {
        const normalizedLine = stripAnsi(line).trim();
        if (!normalizedLine) {
            continue;
        }

        const issueId = classifyIssue(normalizedLine);
        const scope = extractScope(normalizedLine);
        const signature = normalizeSignature(normalizedLine);

        issueCounts.set(issueId, (issueCounts.get(issueId) || 0) + 1);
        scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
        signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);

        for (const conditionId of extractFieldValues(normalizedLine, 'condition')) {
            conditionCounts.set(conditionId, (conditionCounts.get(conditionId) || 0) + 1);
        }

        for (const asset of extractFieldValues(normalizedLine, 'asset')) {
            assetCounts.set(asset, (assetCounts.get(asset) || 0) + 1);
        }

        if (!issueSamples.has(issueId)) {
            issueSamples.set(issueId, []);
        }

        const samples = issueSamples.get(issueId);
        if (samples.length < 3) {
            samples.push(normalizedLine);
        }
    }

    const issueLabelMap = buildIssueLabelMap();
    return {
        totalLines: lines.length,
        issueCounts: takeTopEntries(issueCounts, top).map(([key, value]) => ({
            issueId: key,
            label: issueLabelMap[key] || key,
            count: value,
        })),
        scopeCounts: takeTopEntries(scopeCounts, top).map(([key, value]) => ({
            scope: key,
            count: value,
        })),
        signatureCounts: takeTopEntries(signatureCounts, top).map(([signature, count]) => ({
            signature,
            count,
        })),
        hotConditions: takeTopEntries(conditionCounts, top).map(([conditionId, count]) => ({
            conditionId,
            count,
        })),
        hotAssets: takeTopEntries(assetCounts, top).map(([asset, count]) => ({ asset, count })),
        issueSamples: Array.from(issueSamples.entries()).map(([issueId, samples]) => ({
            issueId,
            label: issueLabelMap[issueId] || issueId,
            samples,
        })),
    };
};

const buildSuggestions = (summary) => {
    const suggestions = [];
    const totalLines = Math.max(toSafeNumber(summary.totalLines), 1);
    const issueCountMap = new Map(summary.issueCounts.map((item) => [item.issueId, item.count]));

    for (const rule of ISSUE_RULES) {
        pushSuggestion(
            suggestions,
            pct(issueCountMap.get(rule.id), totalLines) >= 5,
            rule.suggestion
        );
    }

    pushSuggestion(
        suggestions,
        (summary.hotConditions || []).length > 0,
        '如果热点 condition 长时间集中在少数市场，建议把日志、DB、市场状态脚本按 condition 维度串起来复盘，而不是只看全局汇总。'
    );

    if (suggestions.length === 0) {
        suggestions.push(
            '日志里没有明显的高频异常聚类，建议把这份结果与 DB 侧漏斗报告交叉看，以确认是否存在“静默跳过”问题。'
        );
    }

    return suggestions;
};

const renderTopSection = (title, items, formatter) => {
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
    lines.push('运行日志改进点分析');
    lines.push(`- 生成时间: ${formatTimestamp(Date.now())}`);
    lines.push(`- 总日志行数: ${summary.totalLines}`);

    lines.push('');
    lines.push('热点问题');
    lines.push(
        ...renderTopSection(
            '问题分类',
            summary.issueCounts,
            (item) => `${item.label}: ${item.count}`
        )
    );
    lines.push(
        ...renderTopSection(
            '热点 scope',
            summary.scopeCounts,
            (item) => `${item.scope}: ${item.count}`
        )
    );
    lines.push(
        ...renderTopSection(
            '热点签名',
            summary.signatureCounts,
            (item) => `${item.count} 次 | ${item.signature}`
        )
    );
    lines.push(
        ...renderTopSection(
            '热点 condition',
            summary.hotConditions,
            (item) => `${item.conditionId}: ${item.count}`
        )
    );
    lines.push(
        ...renderTopSection(
            '热点 asset',
            summary.hotAssets,
            (item) => `${item.asset}: ${item.count}`
        )
    );

    lines.push('');
    lines.push('样例');
    for (const issueSample of summary.issueSamples.slice(0, 5)) {
        lines.push(`- ${issueSample.label}:`);
        for (const sample of issueSample.samples) {
            lines.push(`  - ${sample}`);
        }
    }

    lines.push('');
    lines.push('建议');
    for (const suggestion of summary.suggestions) {
        lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
};

const main = () => {
    const text = readInputText();
    const lines = text
        .split(/\r?\n/g)
        .map((line) => line.trimEnd())
        .filter(Boolean);

    const summary = summarizeLogLines(lines, argv.top);
    summary.generatedAt = new Date().toISOString();
    summary.suggestions = buildSuggestions(summary);

    if (argv.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    console.log(renderTextSummary(summary));
};

try {
    main();
} catch (error) {
    console.error(`生成日志改进点报告失败: ${error.message}`);
    process.exit(1);
}
