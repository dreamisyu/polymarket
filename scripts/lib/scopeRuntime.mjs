import {
    formatTimestamp,
    normalizeKey,
    readEnv,
    requireEnvValue,
    toSafeNumber,
} from './runtime.mjs';

const ALLOWED_RUN_MODES = new Set(['paper', 'live']);
const ALLOWED_STRATEGY_KINDS = new Set(['fixed_amount', 'signal', 'proportional']);

const normalizeRunMode = (value) => {
    const normalized = String(value || '')
        .trim()
        .toLowerCase();
    return ALLOWED_RUN_MODES.has(normalized) ? normalized : 'paper';
};

const normalizeStrategyKind = (value) => {
    const normalized = String(value || '')
        .trim()
        .toLowerCase();
    return ALLOWED_STRATEGY_KINDS.has(normalized) ? normalized : 'fixed_amount';
};

export const resolveScopeRuntime = (params = {}) => {
    const explicitScopeKey = String(params.scopeKey || readEnv('SCOPE_KEY') || '').trim();
    const sourceWalletInput = String(params.sourceWallet || readEnv('SOURCE_WALLET') || '').trim();
    const targetWalletInput = String(
        params.targetWallet || readEnv('TARGET_WALLET', 'USER_ADDRESS') || ''
    ).trim();
    const runModeInput = String(params.runMode || readEnv('RUN_MODE') || '').trim();
    const strategyKindInput = String(params.strategyKind || readEnv('STRATEGY_KIND') || '').trim();

    let sourceWallet = sourceWalletInput;
    let targetWallet = targetWalletInput;
    let runMode = normalizeRunMode(runModeInput || 'paper');
    let strategyKind = normalizeStrategyKind(strategyKindInput || 'fixed_amount');

    if (explicitScopeKey) {
        const segments = explicitScopeKey.split(':').map((segment) => segment.trim());
        if (segments.length >= 4) {
            sourceWallet = sourceWallet || segments[0];
            targetWallet = targetWallet || segments[1];
            if (!runModeInput) {
                runMode = normalizeRunMode(segments[2]);
            }
            if (!strategyKindInput) {
                strategyKind = normalizeStrategyKind(segments[3]);
            }
        }

        return {
            scopeKey: explicitScopeKey,
            sourceWallet,
            targetWallet,
            runMode,
            strategyKind,
            scopeSource: params.scopeKey ? '--scope-key' : 'SCOPE_KEY',
        };
    }

    if (!sourceWallet || !targetWallet) {
        throw new Error(
            '缺少 scope 参数：请传 --scope-key，或同时提供 SOURCE_WALLET + TARGET_WALLET（可配合 RUN_MODE/STRATEGY_KIND）'
        );
    }

    return {
        scopeKey: `${sourceWallet}:${targetWallet}:${runMode}:${strategyKind}`,
        sourceWallet,
        targetWallet,
        runMode,
        strategyKind,
        scopeSource: 'wallet+mode+strategy',
    };
};

export const getScopedCollectionNames = (scopeKey) => {
    const suffix = normalizeKey(requireEnvValue(String(scopeKey || '').trim(), 'SCOPE_KEY'));
    return {
        sourceEvents: `source_events_${suffix}`,
        executions: `executions_${suffix}`,
        positions: `positions_${suffix}`,
        portfolios: `portfolios_${suffix}`,
        settlementTasks: `settlement_tasks_${suffix}`,
        monitorCursors: `monitor_cursors_${suffix}`,
    };
};

export const buildDateRangeFilter = (fieldName, range) => {
    const filter = {};
    if (toSafeNumber(range?.sinceTs) > 0) {
        filter.$gte = new Date(toSafeNumber(range.sinceTs));
    }

    if (toSafeNumber(range?.untilTs) > 0) {
        filter.$lte = new Date(toSafeNumber(range.untilTs));
    }

    if (Object.keys(filter).length === 0) {
        return {};
    }

    return {
        [fieldName]: filter,
    };
};

export const resolveMongoUri = (mongoUri) =>
    requireEnvValue(String(mongoUri || readEnv('MONGO_URI') || '').trim(), 'MONGO_URI');

export const formatRangeLabel = (range) =>
    `${formatTimestamp(toSafeNumber(range?.sinceTs))} ~ ${formatTimestamp(toSafeNumber(range?.untilTs))}`;
