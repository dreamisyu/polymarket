import mongoose from 'mongoose';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const toSafeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const formatAmount = (value: unknown, digits = 4) => toSafeNumber(value).toFixed(digits);

export const dedupeStrings = (values: Array<string | undefined | null>) =>
    [...new Set(values.map((value) => String(value || '').trim()))].filter(Boolean);

export const mergeReasons = (...reasons: Array<string | undefined | null>) =>
    dedupeStrings(reasons).join('；');

export const mergeStringArrays = (...groups: Array<Array<string | undefined | null> | undefined>) =>
    dedupeStrings(groups.flatMap((group) => group || []));

export const mergeObjectIds = <T extends mongoose.Types.ObjectId>(
    ...groups: Array<T[] | undefined>
) => {
    const merged = new Map<string, T>();
    for (const group of groups) {
        for (const item of group || []) {
            merged.set(String(item), item);
        }
    }

    return [...merged.values()];
};
