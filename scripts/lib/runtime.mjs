import * as dotenv from 'dotenv';
import { existsSync } from 'fs';
import mongoose from 'mongoose';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT_DIR = resolve(__dirname, '../..');
const ENV_PATH_CANDIDATES = Array.from(
    new Set([resolve(process.cwd(), '.env'), resolve(PROJECT_ROOT_DIR, '.env')])
);

export const ENV_FILE_PATH =
    ENV_PATH_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    resolve(PROJECT_ROOT_DIR, '.env');

dotenv.config({ path: ENV_FILE_PATH });

export const readEnv = (...names) => {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value !== 'string') {
            continue;
        }

        const normalized = value.trim();
        if (normalized) {
            return normalized;
        }
    }

    return undefined;
};

export const requireEnvValue = (value, label) => {
    if (String(value || '').trim()) {
        return value;
    }

    throw new Error(`${label} 未定义（当前加载自 ${ENV_FILE_PATH}）`);
};

export const toSafeNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const toSafeInteger = (value, fallback = 0) => {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) ? parsed : fallback;
};

export const normalizeKey = (value) =>
    String(value || '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .toLowerCase();

export const unique = (items) => Array.from(new Set(items));

export const sumBy = (items, getter) =>
    items.reduce((sum, item, index) => sum + toSafeNumber(getter(item, index)), 0);

export const averageBy = (items, getter) => {
    if (!Array.isArray(items) || items.length === 0) {
        return 0;
    }

    return sumBy(items, getter) / items.length;
};

export const pct = (part, total) => {
    const normalizedTotal = toSafeNumber(total);
    if (normalizedTotal <= 0) {
        return 0;
    }

    return (toSafeNumber(part) / normalizedTotal) * 100;
};

export const round = (value, digits = 2) => Number(toSafeNumber(value).toFixed(digits));
export const formatUsd = (value, digits = 6) => `${toSafeNumber(value).toFixed(digits)} USDC`;
export const formatPct = (value, digits = 2) => `${toSafeNumber(value).toFixed(digits)}%`;
export const formatCount = (value) => `${Math.round(toSafeNumber(value))}`;
export const formatAgeMinutes = (value) => `${toSafeNumber(value).toFixed(1)} 分钟`;

export const groupBy = (items, keyGetter) => {
    const result = new Map();
    for (const item of items) {
        const key = keyGetter(item);
        if (!result.has(key)) {
            result.set(key, []);
        }

        result.get(key).push(item);
    }

    return result;
};

export const countBy = (items, keyGetter) => {
    const counts = new Map();
    for (const item of items) {
        const key = String(keyGetter(item) || '').trim() || 'UNKNOWN';
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return counts;
};

export const takeTopEntries = (mapOrObject, limit = 10) => {
    const entries = Array.isArray(mapOrObject)
        ? mapOrObject
        : mapOrObject instanceof Map
          ? Array.from(mapOrObject.entries())
          : Object.entries(mapOrObject || {});

    return entries
        .sort((left, right) => toSafeNumber(right[1]) - toSafeNumber(left[1]))
        .slice(0, limit);
};

export const quantile = (values, ratio) => {
    const normalized = values
        .map((value) => toSafeNumber(value))
        .filter((value) => Number.isFinite(value));
    if (normalized.length === 0) {
        return 0;
    }

    const ordered = [...normalized].sort((left, right) => left - right);
    const index = Math.min(
        ordered.length - 1,
        Math.max(0, Math.floor((ordered.length - 1) * Math.min(Math.max(ratio, 0), 1)))
    );
    return ordered[index];
};

export const buildTimeRange = ({ hours = 0, sinceTs = 0, untilTs = 0 } = {}) => {
    const now = Date.now();
    const resolvedUntilTs = Math.max(toSafeNumber(untilTs), 0) || now;
    let resolvedSinceTs = Math.max(toSafeNumber(sinceTs), 0);

    if (resolvedSinceTs <= 0 && toSafeNumber(hours) > 0) {
        resolvedSinceTs = resolvedUntilTs - toSafeNumber(hours) * 60 * 60 * 1000;
    }

    return {
        sinceTs: resolvedSinceTs > 0 ? resolvedSinceTs : 0,
        untilTs: resolvedUntilTs > 0 ? resolvedUntilTs : 0,
    };
};

export const buildTimeRangeFilter = (fieldName, range) => {
    const filter = {};
    if (toSafeNumber(range?.sinceTs) > 0) {
        filter.$gte = toSafeNumber(range.sinceTs);
    }

    if (toSafeNumber(range?.untilTs) > 0) {
        filter.$lte = toSafeNumber(range.untilTs);
    }

    if (Object.keys(filter).length === 0) {
        return {};
    }

    return {
        [fieldName]: filter,
    };
};

export const normalizeReason = (value) => String(value || '').trim() || 'UNKNOWN';

export const getTraceRuntimeNamespace = (traceId) => `trace_${normalizeKey(traceId || 'default')}`;

export const getTraceCollectionNames = (walletAddress, traceId) => {
    const suffix = `${normalizeKey(walletAddress)}_${normalizeKey(traceId)}`;
    return {
        execution: `trace_executions_${suffix}`,
        position: `trace_positions_${suffix}`,
        portfolio: `trace_portfolios_${suffix}`,
        settlementTask: `trace_settlement_tasks_${suffix}`,
        sourceActivity: `user_activities_${walletAddress}`,
    };
};

const getCollectionSuffix = (walletAddress, namespace = '') =>
    namespace
        ? `${normalizeKey(walletAddress)}_${normalizeKey(namespace)}`
        : normalizeKey(walletAddress);

export const getCopyIntentBufferCollectionName = (walletAddress, namespace = '') =>
    `copy_intent_buffers_${getCollectionSuffix(walletAddress, namespace)}`;

export const getCopyExecutionBatchCollectionName = (walletAddress, namespace = '') =>
    `copy_execution_batches_${getCollectionSuffix(walletAddress, namespace)}`;

export const getUserActivityCollectionName = (walletAddress) => `user_activities_${walletAddress}`;

export const connectMongo = async (mongoUri) => {
    await mongoose.connect(requireEnvValue(mongoUri, 'MONGO_URI'), {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 5,
    });
};

export const closeMongo = async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
};

export const getCollectionIfExists = async (collectionName) => {
    const collections = await mongoose.connection.db
        .listCollections({ name: collectionName }, { nameOnly: true })
        .toArray();

    if (collections.length === 0) {
        return null;
    }

    return mongoose.connection.db.collection(collectionName);
};

export const fetchCollectionDocs = async (collectionName, filter = {}, options = {}) => {
    const collection = await getCollectionIfExists(collectionName);
    if (!collection) {
        return [];
    }

    const { sort = {}, projection = undefined, limit = 0 } = options;

    let cursor = collection.find(filter, projection ? { projection } : {});

    if (Object.keys(sort).length > 0) {
        cursor = cursor.sort(sort);
    }

    if (toSafeInteger(limit) > 0) {
        cursor = cursor.limit(toSafeInteger(limit));
    }

    return cursor.toArray();
};

export const fetchSingleDoc = async (collectionName, filter = {}, options = {}) => {
    const docs = await fetchCollectionDocs(collectionName, filter, { ...options, limit: 1 });
    return docs[0] || null;
};

export const formatTimestamp = (value) => {
    const timestamp = toSafeNumber(value);
    if (timestamp <= 0) {
        return '-';
    }

    return new Date(timestamp).toISOString();
};

export const pushSuggestion = (suggestions, condition, message) => {
    if (condition) {
        suggestions.push(message);
    }
};
