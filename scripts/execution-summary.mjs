import axios from 'axios';
import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import mongoose from 'mongoose';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT_DIR = resolve(__dirname, '..');
const ENV_PATH_CANDIDATES = Array.from(
    new Set([resolve(process.cwd(), '.env'), resolve(PROJECT_ROOT_DIR, '.env')])
);
const ENV_FILE_PATH =
    ENV_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    resolve(PROJECT_ROOT_DIR, '.env');

dotenv.config({ path: ENV_FILE_PATH });

const RETRY_LIMIT = Number.parseInt(process.env.RETRY_LIMIT || '3', 10);
const DEFAULT_MODE = process.env.EXECUTION_MODE === 'trace' ? 'trace' : 'live';

const parseArgs = (argv) => {
    const parsed = {
        mode: DEFAULT_MODE,
        traceId: process.env.TRACE_ID || 'default',
        json: false,
        settlementWallet: '',
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

        if ((current === '--settlement-wallet' || current === '-w') && argv[index + 1]) {
            parsed.settlementWallet = argv[index + 1];
            index += 1;
        }
    }

    return parsed;
};

const argv = parseArgs(process.argv.slice(2));

if (argv.help) {
    console.log(`用法:
  node scripts/execution-summary.mjs [--mode live|trace] [--trace-id paper] [--settlement-wallet 0x...] [--json]

说明:
  1. 默认读取当前工作目录或项目根目录的 .env
  2. live 模式默认统计 PROXY_WALLET 的 Polymarket 持仓
  3. trace 模式默认对照 USER_ADDRESS 的 Polymarket 持仓，可用 --settlement-wallet 覆盖
  4. --json 可输出机器可读结果
`);
    process.exit(0);
}

const requireEnv = (name) => {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} 未定义（当前加载自 ${ENV_FILE_PATH}）`);
    }

    return value;
};

const toSafeNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeKey = (value) =>
    String(value || '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase();
const sumBy = (items, getter) => items.reduce((sum, item) => sum + toSafeNumber(getter(item)), 0);
const formatUsd = (value) => `${toSafeNumber(value).toFixed(4)} USDC`;
const formatPct = (value) => `${toSafeNumber(value).toFixed(2)}%`;

const getCollectionIfExists = async (collectionName) => {
    const collections = await mongoose.connection.db
        .listCollections({ name: collectionName }, { nameOnly: true })
        .toArray();

    if (collections.length === 0) {
        return null;
    }

    return mongoose.connection.db.collection(collectionName);
};

const fetchCollectionDocs = async (collectionName, filter = {}, sort = {}) => {
    const collection = await getCollectionIfExists(collectionName);
    if (!collection) {
        return [];
    }

    return collection.find(filter).sort(sort).toArray();
};

const fetchSingleDoc = async (collectionName, filter = {}, sort = {}) => {
    const docs = await fetchCollectionDocs(collectionName, filter, sort);
    return docs[0] || null;
};

const fetchPolymarketPositions = async (walletAddress) => {
    if (!walletAddress) {
        return {
            walletAddress: '',
            positions: null,
            error: '未提供结算钱包地址',
        };
    }

    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/positions?user=${walletAddress}`,
            {
                timeout: 10000,
                headers: {
                    'User-Agent': 'polymarket-copytrading-bot/summary-script',
                },
            }
        );

        return {
            walletAddress,
            positions: Array.isArray(response.data) ? response.data : [],
            error: '',
        };
    } catch (error) {
        return {
            walletAddress,
            positions: null,
            error: error?.response?.data?.error || error?.message || '获取 Polymarket 持仓失败',
        };
    }
};

const summarizePolymarketPositions = (positions) => {
    const openPositions = positions.filter((position) => toSafeNumber(position.size) > 0);
    const redeemablePositions = openPositions.filter((position) => Boolean(position.redeemable));
    const mergeablePositions = openPositions.filter((position) => Boolean(position.mergeable));

    return {
        positionCount: openPositions.length,
        redeemableCount: redeemablePositions.length,
        mergeableCount: mergeablePositions.length,
        totalSize: sumBy(openPositions, (position) => position.size),
        totalInitialValue: sumBy(openPositions, (position) => position.initialValue),
        totalCurrentValue: sumBy(openPositions, (position) => position.currentValue),
        totalCashPnl: sumBy(openPositions, (position) => position.cashPnl),
        totalRealizedPnl: sumBy(openPositions, (position) => position.realizedPnl),
        redeemableValue: sumBy(redeemablePositions, (position) => position.currentValue),
        mergeableValue: sumBy(mergeablePositions, (position) => position.currentValue),
        markToMarketPnl:
            sumBy(openPositions, (position) => position.currentValue) -
            sumBy(openPositions, (position) => position.initialValue),
    };
};

const resolveLiveStatus = (activity) => {
    if (activity.botStatus) {
        return activity.botStatus;
    }

    if (activity.bot === true) {
        return 'COMPLETED';
    }

    if (toSafeNumber(activity.botExcutedTime) >= RETRY_LIMIT) {
        return 'FAILED';
    }

    return 'PENDING';
};

const buildFailureItems = (items, statusResolver) =>
    items
        .filter((item) => ['FAILED', 'PROCESSING'].includes(statusResolver(item)))
        .sort((left, right) => toSafeNumber(right.timestamp) - toSafeNumber(left.timestamp))
        .slice(0, 10)
        .map((item) => ({
            transactionHash: item.transactionHash || '',
            status: statusResolver(item),
            side: item.side || item.sourceSide || '',
            title: item.title || '',
            reason: item.botLastError || item.reason || '',
            timestamp: toSafeNumber(item.timestamp || item.sourceTimestamp),
        }));

const summarizeLiveMode = async ({ userAddress, settlementWallet }) => {
    const activities = await fetchCollectionDocs(
        `user_activities_${userAddress}`,
        { type: 'TRADE' },
        { timestamp: 1 }
    );
    const settlement = await fetchPolymarketPositions(settlementWallet);
    const positionSummary = Array.isArray(settlement.positions)
        ? summarizePolymarketPositions(settlement.positions)
        : null;
    const completedActivities = activities.filter(
        (activity) => resolveLiveStatus(activity) === 'COMPLETED'
    );

    return {
        mode: 'live',
        sourceWallet: userAddress,
        settlementWallet: settlement.walletAddress,
        recordSummary: {
            totalTradesCaptured: activities.length,
            completedCount: activities.filter(
                (activity) => resolveLiveStatus(activity) === 'COMPLETED'
            ).length,
            skippedCount: activities.filter((activity) => resolveLiveStatus(activity) === 'SKIPPED')
                .length,
            failedCount: activities.filter((activity) => resolveLiveStatus(activity) === 'FAILED')
                .length,
            processingCount: activities.filter(
                (activity) => resolveLiveStatus(activity) === 'PROCESSING'
            ).length,
            pendingCount: activities.filter((activity) => resolveLiveStatus(activity) === 'PENDING')
                .length,
            buyCount: completedActivities.filter(
                (activity) => String(activity.side || '').toUpperCase() === 'BUY'
            ).length,
            sellCount: completedActivities.filter(
                (activity) => String(activity.side || '').toUpperCase() === 'SELL'
            ).length,
            mergeCount: completedActivities.filter(
                (activity) => String(activity.side || '').toUpperCase() === 'MERGE'
            ).length,
        },
        pnlSummary: positionSummary
            ? {
                  totalCashPnl: positionSummary.totalCashPnl,
                  totalRealizedPnl: positionSummary.totalRealizedPnl,
                  markToMarketPnl: positionSummary.markToMarketPnl,
                  totalCurrentValue: positionSummary.totalCurrentValue,
                  totalInitialValue: positionSummary.totalInitialValue,
              }
            : null,
        settlementSummary: positionSummary
            ? {
                  positionCount: positionSummary.positionCount,
                  redeemableCount: positionSummary.redeemableCount,
                  mergeableCount: positionSummary.mergeableCount,
                  redeemableValue: positionSummary.redeemableValue,
                  mergeableValue: positionSummary.mergeableValue,
              }
            : null,
        failedItems: buildFailureItems(activities, resolveLiveStatus),
        warnings: settlement.error ? [settlement.error] : [],
    };
};

const matchRemotePosition = (remotePositions, localPosition) =>
    remotePositions.find((position) => position.asset === localPosition.asset) ||
    remotePositions.find(
        (position) =>
            position.conditionId === localPosition.conditionId &&
            position.outcome === localPosition.outcome
    ) ||
    remotePositions.find((position) => position.conditionId === localPosition.conditionId);

const summarizeTraceSettlement = (tracePositions, remotePositions) => {
    const localOpenPositions = tracePositions.filter((position) => toSafeNumber(position.size) > 0);
    const matchedPositions = localOpenPositions.map((position) => ({
        local: position,
        remote: matchRemotePosition(remotePositions, position),
    }));

    return {
        localOpenCount: localOpenPositions.length,
        localClosedCount: tracePositions.filter(
            (position) => toSafeNumber(position.size) === 0 || Boolean(position.closedAt)
        ).length,
        matchedPolymarketCount: matchedPositions.filter((item) => Boolean(item.remote)).length,
        redeemableCount: matchedPositions.filter((item) => item.remote?.redeemable).length,
        mergeableCount: matchedPositions.filter((item) => item.remote?.mergeable).length,
        unmatchedCount: matchedPositions.filter((item) => !item.remote).length,
    };
};

const summarizeTraceMode = async ({ userAddress, traceId, settlementWallet }) => {
    const suffix = `${normalizeKey(userAddress)}_${normalizeKey(traceId)}`;
    const executionCollection = `trace_executions_${suffix}`;
    const positionCollection = `trace_positions_${suffix}`;
    const portfolioCollection = `trace_portfolios_${suffix}`;
    const executions = await fetchCollectionDocs(executionCollection, {}, { sourceTimestamp: 1 });
    const positions = await fetchCollectionDocs(positionCollection, {}, { lastTradedAt: 1 });
    const portfolio = await fetchSingleDoc(portfolioCollection, {}, { updatedAt: -1 });
    const settlement = await fetchPolymarketPositions(settlementWallet);

    return {
        mode: 'trace',
        sourceWallet: userAddress,
        traceId,
        settlementWallet: settlement.walletAddress,
        recordSummary: {
            totalExecutions: executions.length,
            filledCount: executions.filter((execution) => execution.status === 'FILLED').length,
            skippedCount: executions.filter((execution) => execution.status === 'SKIPPED').length,
            failedCount: executions.filter((execution) => execution.status === 'FAILED').length,
            processingCount: executions.filter((execution) => execution.status === 'PROCESSING')
                .length,
            buyCount: executions.filter(
                (execution) =>
                    execution.status === 'FILLED' && execution.executionCondition === 'buy'
            ).length,
            sellCount: executions.filter(
                (execution) =>
                    execution.status === 'FILLED' && execution.executionCondition === 'sell'
            ).length,
            mergeCount: executions.filter(
                (execution) =>
                    execution.status === 'FILLED' && execution.executionCondition === 'merge'
            ).length,
        },
        pnlSummary: portfolio
            ? {
                  initialBalance: toSafeNumber(portfolio.initialBalance),
                  cashBalance: toSafeNumber(portfolio.cashBalance),
                  realizedPnl: toSafeNumber(portfolio.realizedPnl),
                  unrealizedPnl: toSafeNumber(portfolio.unrealizedPnl),
                  netPnl: toSafeNumber(portfolio.netPnl),
                  totalEquity: toSafeNumber(portfolio.totalEquity),
                  returnPct: toSafeNumber(portfolio.returnPct),
              }
            : null,
        settlementSummary: Array.isArray(settlement.positions)
            ? summarizeTraceSettlement(positions, settlement.positions)
            : {
                  localOpenCount: positions.filter((position) => toSafeNumber(position.size) > 0)
                      .length,
                  localClosedCount: positions.filter(
                      (position) => toSafeNumber(position.size) === 0 || Boolean(position.closedAt)
                  ).length,
                  matchedPolymarketCount: 0,
                  redeemableCount: 0,
                  mergeableCount: 0,
                  unmatchedCount: positions.filter((position) => toSafeNumber(position.size) > 0)
                      .length,
              },
        failedItems: buildFailureItems(executions, (execution) => execution.status || 'UNKNOWN'),
        warnings: settlement.error
            ? [
                  `${settlement.error}；trace 模式下仍已输出本地账本统计，Polymarket 结算对照可能不完整`,
              ]
            : [
                  `trace 模式默认对照 ${settlement.walletAddress} 的 Polymarket 持仓，` +
                      '仅用于观察市场结算态，不代表模拟仓位真实托管。',
              ],
    };
};

const printHumanReadable = (summary) => {
    const lines = [];

    lines.push(`执行汇总 (${summary.mode})`);
    lines.push(`统计时间: ${new Date().toISOString()}`);
    lines.push(`源钱包: ${summary.sourceWallet}`);
    if (summary.traceId) {
        lines.push(`Trace ID: ${summary.traceId}`);
    }
    if (summary.settlementWallet) {
        lines.push(`结算对照钱包: ${summary.settlementWallet}`);
    }

    lines.push('');
    lines.push('交易统计');
    lines.push(`- 买入次数: ${toSafeNumber(summary.recordSummary.buyCount)}`);
    lines.push(`- 卖出次数: ${toSafeNumber(summary.recordSummary.sellCount)}`);
    lines.push(`- Merge 次数: ${toSafeNumber(summary.recordSummary.mergeCount)}`);
    lines.push(
        `- 已完成/已跳过/失败/处理中: ` +
            `${toSafeNumber(summary.recordSummary.completedCount ?? summary.recordSummary.filledCount)}/` +
            `${toSafeNumber(summary.recordSummary.skippedCount)}/` +
            `${toSafeNumber(summary.recordSummary.failedCount)}/` +
            `${toSafeNumber(summary.recordSummary.processingCount)}`
    );

    if (summary.recordSummary.pendingCount !== undefined) {
        lines.push(`- 待处理次数: ${toSafeNumber(summary.recordSummary.pendingCount)}`);
    }

    lines.push('');
    lines.push('盈亏汇总');
    if (!summary.pnlSummary) {
        lines.push('- 当前无法生成盈亏汇总');
    } else if (summary.mode === 'trace') {
        lines.push(`- 净盈亏: ${formatUsd(summary.pnlSummary.netPnl)}`);
        lines.push(`- 已实现盈亏: ${formatUsd(summary.pnlSummary.realizedPnl)}`);
        lines.push(`- 未实现盈亏: ${formatUsd(summary.pnlSummary.unrealizedPnl)}`);
        lines.push(`- 总权益: ${formatUsd(summary.pnlSummary.totalEquity)}`);
        lines.push(`- 收益率: ${formatPct(summary.pnlSummary.returnPct)}`);
    } else {
        lines.push(`- Cash PnL: ${formatUsd(summary.pnlSummary.totalCashPnl)}`);
        lines.push(`- 已实现盈亏: ${formatUsd(summary.pnlSummary.totalRealizedPnl)}`);
        lines.push(`- Mark-to-Market 盈亏: ${formatUsd(summary.pnlSummary.markToMarketPnl)}`);
        lines.push(`- 当前市值: ${formatUsd(summary.pnlSummary.totalCurrentValue)}`);
    }

    lines.push('');
    lines.push('结算统计');
    Object.entries(summary.settlementSummary || {}).forEach(([key, value]) => {
        const displayValue =
            typeof value === 'number' && key.toLowerCase().includes('value')
                ? formatUsd(value)
                : value;
        lines.push(`- ${key}: ${displayValue}`);
    });

    lines.push('');
    lines.push('失败项');
    if (!summary.failedItems.length) {
        lines.push('- 无');
    } else {
        summary.failedItems.forEach((item) => {
            lines.push(
                `- [${item.status}] ${item.transactionHash || 'unknown'} ${item.side || ''} ` +
                    `${item.title || ''} ${item.reason ? `| ${item.reason}` : ''}`.trim()
            );
        });
    }

    if (summary.warnings?.length) {
        lines.push('');
        lines.push('提示');
        summary.warnings.forEach((warning) => {
            lines.push(`- ${warning}`);
        });
    }

    console.log(lines.join('\n'));
};

const main = async () => {
    const userAddress = requireEnv('USER_ADDRESS');
    const mongoUri = requireEnv('MONGO_URI');
    const proxyWallet = process.env.PROXY_WALLET || '';
    const settlementWallet =
        argv.settlementWallet || (argv.mode === 'live' ? proxyWallet : userAddress);

    await mongoose.connect(mongoUri);

    try {
        const summary =
            argv.mode === 'trace'
                ? await summarizeTraceMode({
                      userAddress,
                      traceId: argv.traceId,
                      settlementWallet,
                  })
                : await summarizeLiveMode({
                      userAddress,
                      settlementWallet,
                  });

        if (argv.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }

        printHumanReadable(summary);
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((error) => {
    console.error('生成执行汇总失败:', error);
    process.exit(1);
});
