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
const BUY_MIN_TOP_UP_TRIGGER_USDC = Number.parseFloat(
    process.env.BUY_MIN_TOP_UP_TRIGGER_USDC || '0.7'
);
const BOOTSTRAP_POLICY_IDS = new Set(['first-entry-ticket', 'buffer-min-top-up']);
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
const normalizeStatus = (value) =>
    String(value || '')
        .trim()
        .toUpperCase();
const normalizeCondition = (value) =>
    String(value || '')
        .trim()
        .toLowerCase();
const sumBy = (items, getter) => items.reduce((sum, item) => sum + toSafeNumber(getter(item)), 0);
const formatUsd = (value) => `${toSafeNumber(value).toFixed(4)} USDC`;
const formatPct = (value) => `${toSafeNumber(value).toFixed(2)}%`;
const countItems = (items, predicate) => items.filter(predicate).length;
const hasCollectionDocs = (items) => Array.isArray(items) && items.length > 0;
const hasPolicyId = (policyTrail, policyIds) =>
    Array.isArray(policyTrail) &&
    policyTrail.some((entry) => policyIds.has(String(entry?.policyId || '').trim()));
const getSourceTradeCount = (item, fieldName = 'sourceTradeIds') => {
    const storedCount = toSafeNumber(item?.sourceTradeCount, 0);
    if (storedCount > 0) {
        return storedCount;
    }

    return Array.isArray(item?.[fieldName]) ? item[fieldName].length : 0;
};
const getBatchTimestamp = (batch) =>
    toSafeNumber(
        batch?.completedAt ||
            batch?.confirmedAt ||
            batch?.submittedAt ||
            batch?.sourceEndedAt ||
            batch?.sourceStartedAt ||
            batch?.createdAt
    );
const getBufferTimestamp = (buffer) =>
    toSafeNumber(
        buffer?.completedAt ||
            buffer?.expireAt ||
            buffer?.flushAfter ||
            buffer?.sourceEndedAt ||
            buffer?.sourceStartedAt ||
            buffer?.createdAt
    );
const getCollectionSuffix = (walletAddress, namespace = '') =>
    namespace
        ? `${normalizeKey(walletAddress)}_${normalizeKey(namespace)}`
        : normalizeKey(walletAddress);
const getCopyIntentBufferCollectionName = (walletAddress, namespace = '') =>
    `copy_intent_buffers_${getCollectionSuffix(walletAddress, namespace)}`;
const getCopyExecutionBatchCollectionName = (walletAddress, namespace = '') =>
    `copy_execution_batches_${getCollectionSuffix(walletAddress, namespace)}`;
const getTraceRuntimeNamespace = (traceId) => `trace_${traceId}`;

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
            `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0`,
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

const isCompletedLiveStatus = (status) => ['CONFIRMED', 'COMPLETED'].includes(status);

const buildFailureItems = (items, statusResolver) =>
    items
        .filter((item) => ['FAILED', 'PROCESSING', 'SUBMITTED'].includes(statusResolver(item)))
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

const buildBatchAttentionItems = (batches) =>
    batches
        .filter((batch) =>
            ['FAILED', 'PROCESSING', 'SUBMITTED', 'READY'].includes(normalizeStatus(batch.status))
        )
        .sort((left, right) => getBatchTimestamp(right) - getBatchTimestamp(left))
        .slice(0, 10)
        .map((batch) => ({
            transactionHash:
                batch.transactionHashes?.[batch.transactionHashes.length - 1] ||
                batch.sourceTransactionHashes?.[batch.sourceTransactionHashes.length - 1] ||
                `batch:${String(batch._id || '')}`,
            status: normalizeStatus(batch.status) || 'UNKNOWN',
            side: batch.side || batch.condition || '',
            title: batch.title || '',
            reason: batch.reason || '',
            timestamp: getBatchTimestamp(batch),
        }));

const buildBufferAttentionItems = (buffers) =>
    buffers
        .filter((buffer) => ['OPEN', 'FLUSHING'].includes(normalizeStatus(buffer.state)))
        .sort((left, right) => getBufferTimestamp(right) - getBufferTimestamp(left))
        .slice(0, 10)
        .map((buffer) => ({
            transactionHash:
                buffer.sourceTransactionHashes?.[buffer.sourceTransactionHashes.length - 1] ||
                `buffer:${String(buffer._id || '')}`,
            status: normalizeStatus(buffer.state) || 'UNKNOWN',
            side: buffer.side || buffer.condition || '',
            title: buffer.title || '',
            reason: buffer.reason || '',
            timestamp: getBufferTimestamp(buffer),
        }));

const mergeAttentionItems = (...groups) =>
    groups
        .flat()
        .sort((left, right) => toSafeNumber(right.timestamp) - toSafeNumber(left.timestamp))
        .slice(0, 10);

const summarizeSourceTrades = (activities) => {
    const tradeActivities = activities.filter(
        (activity) => String(activity.type || '').toUpperCase() === 'TRADE'
    );
    return {
        totalCount: tradeActivities.length,
        buyCount: countItems(
            tradeActivities,
            (activity) => String(activity.side || '').toUpperCase() === 'BUY'
        ),
        sellCount: countItems(
            tradeActivities,
            (activity) => String(activity.side || '').toUpperCase() === 'SELL'
        ),
        mergeCount: countItems(
            tradeActivities,
            (activity) => String(activity.side || '').toUpperCase() === 'MERGE'
        ),
    };
};

const summarizeExecutionBatches = (batches) => {
    const confirmedBatches = batches.filter(
        (batch) => normalizeStatus(batch.status) === 'CONFIRMED'
    );
    const buyBatches = batches.filter((batch) => normalizeCondition(batch.condition) === 'buy');
    const buyConfirmedCount = countItems(
        buyBatches,
        (batch) => normalizeStatus(batch.status) === 'CONFIRMED'
    );
    const buySkippedCount = countItems(
        buyBatches,
        (batch) => normalizeStatus(batch.status) === 'SKIPPED'
    );
    return {
        totalCount: batches.length,
        readyCount: countItems(batches, (batch) => normalizeStatus(batch.status) === 'READY'),
        processingCount: countItems(
            batches,
            (batch) => normalizeStatus(batch.status) === 'PROCESSING'
        ),
        submittedCount: countItems(
            batches,
            (batch) => normalizeStatus(batch.status) === 'SUBMITTED'
        ),
        confirmedCount: confirmedBatches.length,
        skippedCount: countItems(batches, (batch) => normalizeStatus(batch.status) === 'SKIPPED'),
        failedCount: countItems(batches, (batch) => normalizeStatus(batch.status) === 'FAILED'),
        buyCount: buyConfirmedCount,
        buySkippedCount,
        buyParticipationPct:
            buyConfirmedCount + buySkippedCount > 0
                ? (buyConfirmedCount / (buyConfirmedCount + buySkippedCount)) * 100
                : 0,
        sellCount: countItems(
            confirmedBatches,
            (batch) => normalizeCondition(batch.condition) === 'sell'
        ),
        mergeCount: countItems(
            confirmedBatches,
            (batch) => normalizeCondition(batch.condition) === 'merge'
        ),
        sourceTradeCount: sumBy(batches, (batch) => getSourceTradeCount(batch)),
        totalRequestedUsdc: sumBy(batches, (batch) => batch.requestedUsdc),
        totalRequestedSize: sumBy(batches, (batch) => batch.requestedSize),
        bootstrapBatchCount: countItems(batches, (batch) =>
            hasPolicyId(batch.policyTrail, BOOTSTRAP_POLICY_IDS)
        ),
        buySlippageSkipCount: countItems(
            buyBatches,
            (batch) =>
                normalizeStatus(batch.status) === 'SKIPPED' &&
                String(batch.reason || '').includes('当前买价超出允许滑点')
        ),
    };
};

const summarizeIntentBuffers = (buffers) => {
    const activeBuffers = buffers.filter((buffer) =>
        ['OPEN', 'FLUSHING'].includes(normalizeStatus(buffer.state))
    );
    const nearThresholdBuffers = buffers.filter((buffer) => {
        const requestedUsdc = toSafeNumber(buffer.requestedUsdc);
        return requestedUsdc >= BUY_MIN_TOP_UP_TRIGGER_USDC && requestedUsdc < 1;
    });
    return {
        totalCount: buffers.length,
        openCount: countItems(buffers, (buffer) => normalizeStatus(buffer.state) === 'OPEN'),
        flushingCount: countItems(
            buffers,
            (buffer) => normalizeStatus(buffer.state) === 'FLUSHING'
        ),
        skippedCount: countItems(buffers, (buffer) => normalizeStatus(buffer.state) === 'SKIPPED'),
        closedCount: countItems(buffers, (buffer) => normalizeStatus(buffer.state) === 'CLOSED'),
        sourceTradeCount: sumBy(buffers, (buffer) => getSourceTradeCount(buffer)),
        activeSourceTradeCount: sumBy(activeBuffers, (buffer) => getSourceTradeCount(buffer)),
        bufferLossPct:
            buffers.length > 0
                ? (countItems(buffers, (buffer) => normalizeStatus(buffer.state) === 'SKIPPED') /
                      buffers.length) *
                  100
                : 0,
        nearThresholdSkipCount: countItems(
            nearThresholdBuffers,
            (buffer) => normalizeStatus(buffer.state) === 'SKIPPED'
        ),
        bufferTopUpConvertedCount: countItems(
            buffers,
            (buffer) =>
                normalizeStatus(buffer.state) === 'CLOSED' &&
                hasPolicyId(buffer.policyTrail, BOOTSTRAP_POLICY_IDS) &&
                hasPolicyId(buffer.policyTrail, new Set(['buffer-min-top-up']))
        ),
    };
};

const summarizeLiveMode = async ({ userAddress, settlementWallet }) => {
    const [activities, buffers, batches] = await Promise.all([
        fetchCollectionDocs(`user_activities_${userAddress}`, { type: 'TRADE' }, { timestamp: 1 }),
        fetchCollectionDocs(
            getCopyIntentBufferCollectionName(userAddress),
            {},
            { sourceStartedAt: 1 }
        ),
        fetchCollectionDocs(
            getCopyExecutionBatchCollectionName(userAddress),
            {},
            { sourceStartedAt: 1 }
        ),
    ]);
    const settlement = await fetchPolymarketPositions(settlementWallet);
    const positionSummary = Array.isArray(settlement.positions)
        ? summarizePolymarketPositions(settlement.positions)
        : null;
    const sourceTradeSummary = summarizeSourceTrades(activities);
    const batchSummary = summarizeExecutionBatches(batches);
    const bufferSummary = summarizeIntentBuffers(buffers);
    const hasBatchSummary = hasCollectionDocs(batches);
    const hasPipelineSummary = hasBatchSummary || hasCollectionDocs(buffers);
    const completedActivities = activities.filter((activity) =>
        isCompletedLiveStatus(resolveLiveStatus(activity))
    );
    const legacyAttentionItems = buildFailureItems(
        activities.filter(
            (activity) =>
                !activity.botExecutionBatchId &&
                !['BUFFERED', 'BATCHED'].includes(normalizeStatus(resolveLiveStatus(activity)))
        ),
        resolveLiveStatus
    );

    return {
        mode: 'live',
        sourceWallet: userAddress,
        settlementWallet: settlement.walletAddress,
        recordSummary: {
            totalTradesCaptured: activities.length,
            completedCount: hasBatchSummary
                ? batchSummary.confirmedCount
                : activities.filter((activity) =>
                      isCompletedLiveStatus(resolveLiveStatus(activity))
                  ).length,
            confirmedCount: hasBatchSummary
                ? batchSummary.confirmedCount
                : activities.filter((activity) => resolveLiveStatus(activity) === 'CONFIRMED')
                      .length,
            skippedCount: hasBatchSummary
                ? batchSummary.skippedCount
                : activities.filter((activity) => resolveLiveStatus(activity) === 'SKIPPED').length,
            failedCount: hasBatchSummary
                ? batchSummary.failedCount
                : activities.filter((activity) => resolveLiveStatus(activity) === 'FAILED').length,
            processingCount: hasBatchSummary
                ? batchSummary.processingCount
                : activities.filter((activity) => resolveLiveStatus(activity) === 'PROCESSING')
                      .length,
            submittedCount: hasBatchSummary
                ? batchSummary.submittedCount
                : activities.filter((activity) => resolveLiveStatus(activity) === 'SUBMITTED')
                      .length,
            bufferedCount: activities.filter(
                (activity) => resolveLiveStatus(activity) === 'BUFFERED'
            ).length,
            batchedCount: activities.filter((activity) => resolveLiveStatus(activity) === 'BATCHED')
                .length,
            pendingCount: activities.filter((activity) => resolveLiveStatus(activity) === 'PENDING')
                .length,
            buyCount: hasBatchSummary
                ? batchSummary.buyCount
                : completedActivities.filter(
                      (activity) => String(activity.side || '').toUpperCase() === 'BUY'
                  ).length,
            sellCount: hasBatchSummary
                ? batchSummary.sellCount
                : completedActivities.filter(
                      (activity) => String(activity.side || '').toUpperCase() === 'SELL'
                  ).length,
            mergeCount: hasBatchSummary
                ? batchSummary.mergeCount
                : completedActivities.filter(
                      (activity) => String(activity.side || '').toUpperCase() === 'MERGE'
                  ).length,
        },
        sourceTradeSummary,
        batchSummary,
        bufferSummary,
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
        failedItems: mergeAttentionItems(
            buildBatchAttentionItems(batches),
            buildBufferAttentionItems(buffers),
            legacyAttentionItems
        ),
        warnings: [
            ...(settlement.error ? [settlement.error] : []),
            ...(!hasPipelineSummary && activities.length > 0
                ? ['未发现批次集合，已按旧版活动状态兼容汇总']
                : []),
        ],
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
    const runtimeNamespace = getTraceRuntimeNamespace(traceId);
    const executionCollection = `trace_executions_${suffix}`;
    const positionCollection = `trace_positions_${suffix}`;
    const portfolioCollection = `trace_portfolios_${suffix}`;
    const [executions, positions, portfolio, buffers, batches] = await Promise.all([
        fetchCollectionDocs(executionCollection, {}, { sourceTimestamp: 1 }),
        fetchCollectionDocs(positionCollection, {}, { lastTradedAt: 1 }),
        fetchSingleDoc(portfolioCollection, {}, { updatedAt: -1 }),
        fetchCollectionDocs(
            getCopyIntentBufferCollectionName(userAddress, runtimeNamespace),
            {},
            { sourceStartedAt: 1 }
        ),
        fetchCollectionDocs(
            getCopyExecutionBatchCollectionName(userAddress, runtimeNamespace),
            {},
            { sourceStartedAt: 1 }
        ),
    ]);
    const settlement = await fetchPolymarketPositions(settlementWallet);
    const settlementExecutions = executions.filter(
        (execution) => execution.status === 'FILLED' && execution.executionCondition === 'settle'
    );
    const batchSummary = summarizeExecutionBatches(batches);
    const bufferSummary = summarizeIntentBuffers(buffers);
    const settlementSummary = Array.isArray(settlement.positions)
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
          };

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
            settlementCount: settlementExecutions.length,
        },
        batchSummary,
        bufferSummary,
        pnlSummary: portfolio
            ? {
                  initialBalance: toSafeNumber(portfolio.initialBalance),
                  cashBalance: toSafeNumber(portfolio.cashBalance),
                  positionsMarketValue: toSafeNumber(portfolio.positionsMarketValue),
                  realizedPnl: toSafeNumber(portfolio.realizedPnl),
                  unrealizedPnl: toSafeNumber(portfolio.unrealizedPnl),
                  netPnl: toSafeNumber(portfolio.netPnl),
                  totalEquity: toSafeNumber(portfolio.totalEquity),
                  returnPct: toSafeNumber(portfolio.returnPct),
              }
            : null,
        settlementSummary: {
            ...settlementSummary,
            autoSettledCount: settlementExecutions.length,
            autoSettledValue: sumBy(settlementExecutions, (execution) => execution.executedUsdc),
        },
        failedItems: mergeAttentionItems(
            buildFailureItems(executions, (execution) => execution.status || 'UNKNOWN'),
            buildBatchAttentionItems(batches),
            buildBufferAttentionItems(buffers)
        ),
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
    if (summary.sourceTradeSummary) {
        lines.push(`- 源交易总数: ${toSafeNumber(summary.sourceTradeSummary.totalCount)}`);
        lines.push(
            `- 源 BUY/SELL/MERGE: ` +
                `${toSafeNumber(summary.sourceTradeSummary.buyCount)}/` +
                `${toSafeNumber(summary.sourceTradeSummary.sellCount)}/` +
                `${toSafeNumber(summary.sourceTradeSummary.mergeCount)}`
        );
    }
    lines.push(`- 执行买入次数: ${toSafeNumber(summary.recordSummary.buyCount)}`);
    lines.push(`- 执行卖出次数: ${toSafeNumber(summary.recordSummary.sellCount)}`);
    lines.push(`- 执行 Merge 次数: ${toSafeNumber(summary.recordSummary.mergeCount)}`);
    if (summary.recordSummary.settlementCount !== undefined) {
        lines.push(`- 自动结算次数: ${toSafeNumber(summary.recordSummary.settlementCount)}`);
    }
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
    if (summary.recordSummary.bufferedCount !== undefined) {
        lines.push(`- 缓冲中源交易数: ${toSafeNumber(summary.recordSummary.bufferedCount)}`);
    }
    if (summary.recordSummary.batchedCount !== undefined) {
        lines.push(`- 已入批次源交易数: ${toSafeNumber(summary.recordSummary.batchedCount)}`);
    }
    if (summary.batchSummary?.totalCount) {
        lines.push(
            `- 批次 READY/PROCESSING/SUBMITTED/CONFIRMED/SKIPPED/FAILED: ` +
                `${toSafeNumber(summary.batchSummary.readyCount)}/` +
                `${toSafeNumber(summary.batchSummary.processingCount)}/` +
                `${toSafeNumber(summary.batchSummary.submittedCount)}/` +
                `${toSafeNumber(summary.batchSummary.confirmedCount)}/` +
                `${toSafeNumber(summary.batchSummary.skippedCount)}/` +
                `${toSafeNumber(summary.batchSummary.failedCount)}`
        );
        lines.push(`- 批次覆盖源交易数: ${toSafeNumber(summary.batchSummary.sourceTradeCount)}`);
        lines.push(`- Buy 批次参与率: ${formatPct(summary.batchSummary.buyParticipationPct)}`);
        lines.push(`- Bootstrap 批次数: ${toSafeNumber(summary.batchSummary.bootstrapBatchCount)}`);
        lines.push(
            `- Buy 滑点跳过批次: ${toSafeNumber(summary.batchSummary.buySlippageSkipCount)}`
        );
    }
    if (summary.bufferSummary?.totalCount) {
        lines.push(
            `- 缓冲区 OPEN/FLUSHING/SKIPPED/CLOSED: ` +
                `${toSafeNumber(summary.bufferSummary.openCount)}/` +
                `${toSafeNumber(summary.bufferSummary.flushingCount)}/` +
                `${toSafeNumber(summary.bufferSummary.skippedCount)}/` +
                `${toSafeNumber(summary.bufferSummary.closedCount)}`
        );
        lines.push(
            `- 活跃缓冲区内源交易数: ${toSafeNumber(summary.bufferSummary.activeSourceTradeCount)}`
        );
        lines.push(`- Buffer 损耗率: ${formatPct(summary.bufferSummary.bufferLossPct)}`);
        lines.push(
            `- 近门槛 buffer 跳过数: ${toSafeNumber(summary.bufferSummary.nearThresholdSkipCount)}`
        );
        lines.push(
            `- buffer 补齐成批次数: ${toSafeNumber(summary.bufferSummary.bufferTopUpConvertedCount)}`
        );
    }

    lines.push('');
    lines.push('盈亏汇总');
    if (!summary.pnlSummary) {
        lines.push('- 当前无法生成盈亏汇总');
    } else if (summary.mode === 'trace') {
        lines.push(`- 可用资金: ${formatUsd(summary.pnlSummary.cashBalance)}`);
        lines.push(`- 持仓市值: ${formatUsd(summary.pnlSummary.positionsMarketValue)}`);
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
    lines.push('异常与待处理项');
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
